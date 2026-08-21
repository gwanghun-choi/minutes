"""Chat sessions, messages, and the RAG scope they carry.

Every query filters on the caller's user_id, so another user's session id is a
404 — the ownership boundary is in the SQL, not in the UI.
"""
from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from app.db import conn
from app.services import rag

router = APIRouter(prefix="/api/chat", tags=["chat"])

TITLE_MAX = 40


class ChatRequest(BaseModel):
    question: str
    meeting_id: int | None = None
    top_k: int = 6


class SessionCreate(BaseModel):
    scope_meeting_ids: list[int] = []


class ScopeUpdate(BaseModel):
    scope_meeting_ids: list[int]


class Ask(BaseModel):
    question: str
    top_k: int = 6
    # A miss inside a chosen scope never widens by itself. This flag is the user
    # having clicked "전체 회의에서 검색", and it applies to this question only —
    # the session's own scope is left as it was.
    global_override: bool = False


def _own(c, session_id: int, user_id: int) -> dict:
    row = c.execute(
        "SELECT id, title, scope_meeting_ids FROM chat_sessions"
        " WHERE id = %s AND user_id = %s",
        (session_id, user_id),
    ).fetchone()
    if not row:
        # 404 rather than 403: another user's session must not be distinguishable
        # from one that does not exist.
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return row


@router.post("")
def chat(body: ChatRequest):
    """Stateless one-shot question. Kept for the direct-from-meeting entry point."""
    scope = [body.meeting_id] if body.meeting_id else None
    result = rag.answer(body.question.strip(), scope, min(max(body.top_k, 1), 12))
    return {"answer": result["answer"], "sources": rag.serialize_sources(result["sources"])}


@router.post("/sessions")
def create_session(request: Request, body: SessionCreate):
    with conn() as c:
        return c.execute(
            "INSERT INTO chat_sessions (user_id, scope_meeting_ids) VALUES (%s,%s)"
            " RETURNING id, title, scope_meeting_ids, updated_at",
            (request.state.user["id"], body.scope_meeting_ids),
        ).fetchone()


@router.get("/sessions")
def list_sessions(request: Request):
    with conn() as c:
        return c.execute(
            "SELECT id, title, scope_meeting_ids, updated_at FROM chat_sessions"
            " WHERE user_id = %s ORDER BY updated_at DESC",
            (request.state.user["id"],),
        ).fetchall()


@router.get("/sessions/{session_id}")
def get_session(request: Request, session_id: int):
    with conn() as c:
        session = _own(c, session_id, request.state.user["id"])
        messages = c.execute(
            "SELECT role, content, sources FROM chat_messages"
            " WHERE session_id = %s ORDER BY id",
            (session_id,),
        ).fetchall()
    return {"session": session, "messages": messages}


@router.patch("/sessions/{session_id}")
def set_scope(request: Request, session_id: int, body: ScopeUpdate):
    with conn() as c:
        _own(c, session_id, request.state.user["id"])
        return c.execute(
            "UPDATE chat_sessions SET scope_meeting_ids = %s, updated_at = now()"
            " WHERE id = %s RETURNING id, title, scope_meeting_ids",
            (body.scope_meeting_ids, session_id),
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

    scope = [] if body.global_override else list(session["scope_meeting_ids"])
    result = rag.answer(
        question, scope or None, min(max(body.top_k, 1), 12), history[::-1]
    )
    sources = rag.serialize_sources(result["sources"])

    with conn() as c:
        for role, content, src in (
            ("user", question, []),
            ("assistant", result["answer"], sources),
        ):
            c.execute(
                "INSERT INTO chat_messages (session_id, role, content, sources)"
                " VALUES (%s,%s,%s,%s)",
                (session_id, role, content, Jsonb(src)),
            )
        # The first question names the chat. Truncating it costs nothing; a
        # generated title would be a second LLM call for a sidebar label.
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
