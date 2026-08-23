"""Chat sessions, messages, and the RAG scope they carry.

Every query filters on the caller's user_id, so another user's session id is a
404 — the ownership boundary is in the SQL, not in the UI.

Two boundaries meet here. A session belongs to one account, and so does every
meeting it may search: a scope is intersected with `access.READABLE` before it
reaches retrieval, and the stored evidence on an old message is filtered through
the same rule on the way out. Naming a meeting id in a request has never been
what grants access to it, and after this it cannot even reveal that the id
exists.
"""
from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from app.db import conn
from app.services import access, organization, rag

router = APIRouter(prefix="/api/chat", tags=["chat"])

TITLE_MAX = 40


class SessionCreate(BaseModel):
    scope_meeting_ids: list[int] = []


class ScopeUpdate(BaseModel):
    scope_meeting_ids: list[int]


class TitleUpdate(BaseModel):
    title: str


class CategoryUpdate(BaseModel):
    # null takes the conversation out of a category. The tree is this account's
    # own (migration 011), so there is nothing here another account can name.
    category_id: int | None = None


class Ask(BaseModel):
    question: str
    top_k: int = 6
    # A miss inside a chosen scope never widens by itself. This flag is the user
    # having clicked "전체 회의에서 검색", and it applies to this question only —
    # the session's own scope is left as it was.
    global_override: bool = False


def _own(c, session_id: int, user_id: int) -> dict:
    row = c.execute(
        "SELECT id, title, scope_meeting_ids, category_id FROM chat_sessions"
        " WHERE id = %s AND user_id = %s",
        (session_id, user_id),
    ).fetchone()
    if not row:
        # 404 rather than 403: another user's session must not be distinguishable
        # from one that does not exist.
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return row


def _scope(user_id: int, requested: list[int]) -> list[int]:
    """The scope to store: what was asked for, narrowed to what may be read.

    Narrowed rather than refused, and deliberately. Refusing would have to say
    *which* id was rejected, or at least that one was — and since an id that does
    not exist is indistinguishable from one belonging to somebody else, that
    answer is an existence oracle for every meeting id in the database. Dropping
    silently tells the caller nothing they did not already know.

    It also keeps the stored scope honest: the session ends up holding exactly
    the meetings it can actually search, so "선택한 회의 2개" cannot describe a
    set retrieval will narrow again behind the reader's back. An empty list stays
    empty, which is GLOBAL — and GLOBAL has never meant "every meeting", only
    "every meeting this account may read".
    """
    return access.visible(user_id, requested)


@router.post("/sessions")
def create_session(request: Request, body: SessionCreate):
    user_id = request.state.user["id"]
    scope = _scope(user_id, body.scope_meeting_ids)
    with conn() as c:
        return c.execute(
            "INSERT INTO chat_sessions (user_id, scope_meeting_ids) VALUES (%s,%s)"
            " RETURNING id, title, scope_meeting_ids, category_id, updated_at",
            (user_id, scope),
        ).fetchone()


@router.get("/sessions")
def list_sessions(request: Request):
    with conn() as c:
        return c.execute(
            "SELECT id, title, scope_meeting_ids, category_id, updated_at"
            " FROM chat_sessions WHERE user_id = %s ORDER BY updated_at DESC",
            (request.state.user["id"],),
        ).fetchall()


# What is left of a stored source once the account may no longer read the
# meeting it came from. Enough for the answer's [N] to still point somewhere and
# say why it is blank; none of the transcript it quoted.
REVOKED_SOURCE_TITLE = "접근 권한이 없는 회의"


def _retitle(c, user_id: int, sources: list[dict]) -> list[dict]:
    """Show each source under the name this account gave its meeting.

    Applied when a source is read, not when it is stored: an alias chosen today
    renames the evidence in yesterday's answer too, and clearing it goes back to
    the meeting's own title rather than to a copy of it frozen at retrieval time.
    The stored payload is untouched — this is presentation, and the canonical
    title is what `serialize_sources` wrote.
    """
    ids = [s["meeting_id"] for s in sources if s.get("meeting_id")]
    named = organization.aliases(c, user_id, ids)
    for s in sources:
        if alias := named.get(s.get("meeting_id")):
            s["meeting_title"] = alias
    return sources


def _readable_sources(user_id: int, messages: list[dict]) -> list[dict]:
    """Strip evidence whose meeting this account can no longer read.

    `chat_messages.sources` is a snapshot: it holds the transcript words that
    were retrieved, so it keeps working as provenance without re-reading the
    meeting. That is also why it has to be filtered on the way out — a share
    taken back would otherwise leave the quoted minutes readable forever in
    somebody's chat history.

    The answer text itself is not rewritten. It is the record of a conversation
    this account really had, at a time when it really could see those meetings,
    and silently editing what a person was told is a worse failure than leaving
    a paragraph that quotes something they can no longer open. The detail behind
    it — the meeting, the speakers, the excerpt, the link — is what goes.
    """
    ids = {
        s.get("meeting_id")
        for m in messages
        for s in (m["sources"] or [])
        if s.get("meeting_id")
    }
    allowed = set(access.visible(user_id, sorted(ids))) if ids else set()
    for m in messages:
        m["sources"] = [
            s if s.get("meeting_id") in allowed else {
                "index": s.get("index"),
                "kind": s.get("kind", "chunk"),
                "meeting_id": None,
                "meeting_title": REVOKED_SOURCE_TITLE,
                "speakers": [],
                "start_time": 0,
                "end_time": 0,
                "time_label": "",
                "text": "",
                "score": 0,
                "revoked": True,
            }
            for s in (m["sources"] or [])
        ]
    return messages


@router.get("/sessions/{session_id}")
def get_session(request: Request, session_id: int):
    user_id = request.state.user["id"]
    with conn() as c:
        session = _own(c, session_id, user_id)
        messages = c.execute(
            "SELECT role, content, sources FROM chat_messages"
            " WHERE session_id = %s ORDER BY id",
            (session_id,),
        ).fetchall()
        messages = _readable_sources(user_id, messages)
        for m in messages:
            _retitle(c, user_id, m["sources"])
    return {"session": session, "messages": messages}


@router.patch("/sessions/{session_id}")
def set_scope(request: Request, session_id: int, body: ScopeUpdate):
    user_id = request.state.user["id"]
    with conn() as c:
        # Ownership of the conversation first: somebody else's session id must
        # answer 404 whatever the body says, never a complaint about the body.
        _own(c, session_id, user_id)
        scope = _scope(user_id, body.scope_meeting_ids)
        return c.execute(
            "UPDATE chat_sessions SET scope_meeting_ids = %s, updated_at = now()"
            " WHERE id = %s RETURNING id, title, scope_meeting_ids, category_id",
            (scope, session_id),
        ).fetchone()


@router.patch("/sessions/{session_id}/title")
def set_title(request: Request, session_id: int, body: TitleUpdate):
    """Rename a conversation.

    One field, one endpoint — the same shape as `/held-at` and `/category` on a
    meeting, rather than widening the scope PATCH into a partial update that has
    to decide what else is editable.

    Nothing here protects the new name from the auto-title, because the auto-title
    already only fires while the title is still '새 채팅' (see `ask`). A renamed
    conversation keeps its name with no extra column.
    """
    title = body.title.strip()[:TITLE_MAX]
    if not title:
        raise HTTPException(400, "대화 이름을 입력하세요.")
    with conn() as c:
        _own(c, session_id, request.state.user["id"])
        return c.execute(
            "UPDATE chat_sessions SET title = %s, updated_at = now()"
            " WHERE id = %s RETURNING id, title, scope_meeting_ids, category_id, updated_at",
            (title, session_id),
        ).fetchone()


@router.patch("/sessions/{session_id}/category")
def set_session_category(request: Request, session_id: int, body: CategoryUpdate):
    """File a conversation in one of this account's categories, or unfile it.

    The same tree meetings are filed in, because a person arranging their work
    does not keep two vocabularies for it. A conversation is already owned
    outright, so this is a column rather than a second table — and the composite
    foreign key in migration 011 means the id can only ever be one of the
    caller's own categories.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        _own(c, session_id, user_id)
        category_id = organization.owned(c, user_id, body.category_id)
        return c.execute(
            "UPDATE chat_sessions SET category_id = %s, updated_at = now()"
            " WHERE id = %s RETURNING id, title, scope_meeting_ids, category_id, updated_at",
            (category_id, session_id),
        ).fetchone()


@router.delete("/sessions/{session_id}")
def delete_session(request: Request, session_id: int):
    with conn() as c:
        # Ownership is the predicate, so another user's id deletes nothing.
        row = c.execute(
            "DELETE FROM chat_sessions WHERE id = %s AND user_id = %s RETURNING id",
            (session_id, request.state.user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return {"id": session_id, "deleted": True}


@router.post("/sessions/{session_id}/messages")
def ask(request: Request, session_id: int, body: Ask):
    user_id = request.state.user["id"]
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "질문을 입력하세요.")

    with conn() as c:
        session = _own(c, session_id, user_id)
        history = c.execute(
            "SELECT role, content FROM chat_messages WHERE session_id = %s"
            " ORDER BY id DESC LIMIT %s",
            (session_id, rag.HISTORY_MESSAGES),
        ).fetchall()

    stored = list(session["scope_meeting_ids"])
    scope = [] if body.global_override else access.visible(user_id, stored)
    if stored and not body.global_override and not scope:
        # Every meeting this conversation was scoped to has been revoked or
        # deleted since. Falling back to the whole corpus would answer from
        # meetings the asker never chose, so say what happened instead.
        return {
            "answer": "이 대화의 검색 범위로 지정된 회의에 더 이상 접근할 수 없습니다. "
                      "[범위 변경]에서 다시 선택해 주세요.",
            "sources": [],
            "scope_miss": False,
        }
    # user_id is taken from the session, never from the body, and it is now two
    # things at once: "내가 요청한 것" resolves through this account's own speaker
    # mapping, and every one of the four retrieval paths is restricted to the
    # meetings this account may read. `global_override` widens the *choice*, never
    # the permission — an empty scope still means "everything I may read".
    result = rag.answer(
        question, scope or None, min(max(body.top_k, 1), 12), history[::-1], user_id
    )
    sources = rag.serialize_sources(result["sources"])

    with conn() as c:
        # Stored with the canonical title, shown with this account's own.
        stored_sources = [dict(s) for s in sources]
        _retitle(c, user_id, sources)
        for role, content, src in (
            ("user", question, []),
            ("assistant", result["answer"], stored_sources),
        ):
            c.execute(
                "INSERT INTO chat_messages (session_id, role, content, sources)"
                " VALUES (%s,%s,%s,%s)",
                (session_id, role, content, Jsonb(src)),
            )
        # The first question names the chat. Truncating it costs nothing; a
        # generated title would be a second LLM call for a sidebar label.
        # ponytail: the default title is the sentinel, so a chat deliberately
        # renamed back to '새 채팅' is renamed again by its first question.
        # Revisit when a `title_source` column earns its keep — a boolean for
        # this one indistinguishable case does not.
        c.execute(
            "UPDATE chat_sessions SET updated_at = now(),"
            " title = CASE WHEN title = '새 채팅' THEN %s ELSE title END WHERE id = %s",
            (question[:TITLE_MAX], session_id),
        )

    return {
        "answer": result["answer"],
        "sources": sources,
        # Only ever a prompt to the user. The backend has already finished, and
        # it searched exactly the scope it was given.
        "scope_miss": bool(scope) and rag.is_miss(result),
    }
