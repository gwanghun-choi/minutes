import datetime as dt
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from psycopg.errors import ForeignKeyViolation, UniqueViolation
from pydantic import BaseModel

from app import config
from app.db import conn
from app.services import (
    access, assist, audio, intelligence, organization, pipeline, versions,
)

log = logging.getLogger("minutes.api")
router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# The meeting state machine, in the order a meeting moves through it. Used to
# validate a status filter rather than answering an empty page for a typo.
STATUSES = (
    "UPLOADED", "TRANSCRIBING", "DIARIZING", "REVIEW_REQUIRED",
    "INDEXING", "COMPLETED", "FAILED",
)

# Page size defaults for the meeting list. 20 is what fits the current row
# density without scrolling on a laptop; the browser may ask for more.
PAGE_SIZE_DEFAULT = 20
PAGE_SIZE_MAX = 100

# Which slice of the accessible meetings a list request wants. "" is everything
# this account may read; the two named halves are the tabs the list shows, and
# together they are exactly "". Defined in `access.SCOPES` so the split cannot
# drift from the predicate it splits.
SCOPES = tuple(access.SCOPES)

# The orderings the list offers, as SQL. A whitelist, so the parameter can never
# become an ORDER BY expression. `occurred_at` is the output column below.
SORTS = {
    "held_desc": "occurred_at DESC, m.id DESC",
    "held_asc": "occurred_at ASC, m.id ASC",
    "created_desc": "m.created_at DESC, m.id DESC",
}


# The published revision, as a scalar subquery over a `meetings m` alias. Read
# rather than stored on `meetings`: `meeting_versions` is the authority and a
# denormalized copy is a second answer waiting to disagree with it.
PUBLISHED_VERSION = (
    "(SELECT v.version FROM meeting_versions v"
    "  WHERE v.meeting_id = m.id AND v.status = 'PUBLISHED')"
)
PUBLISHED_AT = (
    "(SELECT v.published_at FROM meeting_versions v"
    "  WHERE v.meeting_id = m.id AND v.status = 'PUBLISHED')"
)


def _parse_held_at(raw: str) -> dt.datetime | None:
    """The optional held_at that comes with an upload, as a form field.

    A multipart field is a string, and an empty one means "not given" rather
    than a malformed date — the browser omits the field when the box is cleared,
    but an empty value must not become a 422 either. Anything else that is not
    ISO 8601 is rejected here rather than stored as a guess.
    """
    if not raw.strip():
        return None
    try:
        return dt.datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(400, "회의 일시 형식이 올바르지 않습니다.") from exc


@router.post("")
async def create_meeting(
    request: Request,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form(""),
    # Additive and optional: an older caller that sends neither still works, and
    # the column stays NULL rather than defaulting to the upload time. The
    # browser proposes "now" in the user's own timezone; the server never infers
    # a meeting date from when the file happened to arrive.
    held_at: str = Form(""),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in config.ALLOWED_EXT:
        raise HTTPException(400, f"지원하지 않는 형식입니다: {ext or '(없음)'}")
    held = _parse_held_at(held_at)

    stored = f"{uuid.uuid4().hex}{ext}"
    dest = config.UPLOAD_DIR / stored
    with dest.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            fh.write(chunk)

    # The owner is the authenticated account and nothing else. There is no
    # owner field in the form and no way to ask for one: a client that could
    # name the owner could hand its upload to somebody else's account, or take
    # somebody else's.
    owner_id = request.state.user["id"]
    with conn() as c:
        row = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status,"
            " held_at, owner_user_id) VALUES (%s,%s,%s,'UPLOADED',%s,%s)"
            " RETURNING id, title, status, created_at, held_at, owner_user_id",
            (title.strip() or Path(file.filename).stem, file.filename, stored, held, owner_id),
        ).fetchone()
        # Version 1 opens with the meeting, in the same transaction, so no
        # meeting can ever exist without a revision to write its transcript into.
        versions.start(row["id"], owner_id, c)

    background.add_task(pipeline.process, row["id"], str(dest))
    return row


def _narrow(
    user_id: int, scope: str, q: str, category: str, status: str, days: int,
    descendants: bool = True,
) -> tuple[str, dict]:
    """The meeting list's WHERE clause and its parameters, built once.

    One definition of "which meetings match", shared by the COUNT and the page
    below so a total can never describe a different set from the rows. Narrowing
    is the database's job now: the list is paginated, and a filter applied in the
    browser would only narrow the page that already arrived.

    The access predicate is the first conjunct and is not a filter the caller
    chose — it is `access.SCOPES`, so the total, the rows, and the retrieval
    layer all agree on which meetings exist for this account. `scope` only picks
    which half of it: "" both, "mine" owned, "shared" accepted invitations.

    A category id matches that category *and everything under it* — the same
    `organization.SUBTREE` walk the tree is built from, so a folder means the
    work under it. "none" is 미분류, which is direct by definition.

    `descendants=False` narrows that to the filings made in exactly this
    category. The sidebar tree asks for it because it draws the folders itself:
    a meeting has to appear under the one it is filed in and nowhere else, or
    the same meeting is two rows pointing at one page. It is a rendering
    question, not a different idea of what a category contains — the list page
    and every count still mean the subtree.

    Filing is personal (migration 011), so the category predicate is a filing
    this *account* made, never a property of the meeting. Two accounts filtering
    by "고객사 A" are asking two different questions and both get their own
    answer; neither can see how the other filed anything.
    """
    if scope not in access.SCOPES:
        raise HTTPException(400, f"알 수 없는 범위입니다: {scope}")
    where = [access.SCOPES[scope]]
    params: dict = access.params(user_id)
    text = q.strip()
    if text:
        where.append("(m.title ILIKE %(q)s OR m.original_filename ILIKE %(q)s)")
        params["q"] = f"%{text}%"
    if category == "none":
        where.append(
            "NOT EXISTS (SELECT 1 FROM user_meeting_filing f"
            " WHERE f.meeting_id = m.id AND f.user_id = %(auth_uid)s"
            "   AND f.category_id IS NOT NULL)"
        )
    elif category:
        try:
            params["cat"] = int(category)
        except ValueError as exc:
            raise HTTPException(400, "카테고리 값이 올바르지 않습니다.") from exc
        match = (
            f"f.category_id IN ({organization.SUBTREE})" if descendants
            else "f.category_id = %(cat)s"
        )
        where.append(
            "EXISTS (SELECT 1 FROM user_meeting_filing f"
            " WHERE f.meeting_id = m.id AND f.user_id = %(auth_uid)s"
            f"   AND {match})"
        )
    if status:
        if status not in STATUSES:
            raise HTTPException(400, f"알 수 없는 상태입니다: {status}")
        where.append("m.status = %(status)s")
        params["status"] = status
    if days > 0:
        where.append(
            "coalesce(m.held_at, m.created_at) >= now() - make_interval(days => %(days)s)"
        )
        params["days"] = days
    return " AND ".join(where), params


@router.get("")
def list_meetings(
    request: Request,
    page: int = 1,
    page_size: int = PAGE_SIZE_DEFAULT,
    q: str = "",
    # "" every category, "none" 미분류 only, otherwise a category id including
    # its descendants.
    category: str = "",
    # Whether that category id reaches the folders under it. True everywhere a
    # person asked for a folder's work; False for the sidebar tree, which draws
    # the folders itself and must not list one meeting twice.
    descendants: bool = True,
    status: str = "",
    # 0 = no limit. Otherwise only meetings held (or, failing that, uploaded)
    # within this many days.
    days: int = 0,
    sort: str = "held_desc",
    # "" everything this account may read, "mine" 내 회의, "shared" 공유받은 회의.
    scope: str = "",
):
    """One page of meetings this account may read, with the total it matched.

    Ownership is not one more filter beside the others: it is applied inside
    `_narrow`, before anything the caller asked for, so a page total, a category
    count, and a "다음 페이지" all describe the same set — the one this account
    is allowed to know about. There is no request shape that reaches somebody
    else's meeting, including a page number past the end of your own.

    The total comes from its own COUNT rather than a window function: a page past
    the end returns no rows, and a UI that has to correct itself needs the real
    total to do it with.
    """
    if sort not in SORTS:
        raise HTTPException(400, f"알 수 없는 정렬입니다: {sort}")
    page = max(page, 1)
    size = min(max(page_size, 1), PAGE_SIZE_MAX)
    where, params = _narrow(
        request.state.user["id"], scope, q, category, status, days, descendants,
    )
    with conn() as c:
        total = c.execute(
            f"SELECT count(*) AS n FROM meetings m WHERE {where}", params
        ).fetchone()["n"]
        rows = c.execute(
            f"""
            SELECT m.*, {organization.COLUMNS},
                   coalesce(m.held_at, m.created_at) AS occurred_at,
                   (SELECT count(*) FROM speakers s WHERE s.meeting_id = m.id) AS speaker_count,
                   m.owner_user_id = %(auth_uid)s AS is_owner,
                   o.display_name AS owner_display_name,
                   {PUBLISHED_VERSION} AS active_version,
                   {PUBLISHED_AT} AS version_published_at
            FROM meetings m{organization.CATEGORY_JOIN}
            LEFT JOIN users o ON o.id = m.owner_user_id
            WHERE {where}
            ORDER BY {SORTS[sort]}
            LIMIT %(limit)s OFFSET %(offset)s
            """,
            {**params, "limit": size, "offset": (page - 1) * size},
        ).fetchall()
    return {"items": rows, "total": total, "page": page, "page_size": size}


@router.get("/{meeting_id}")
def get_meeting(request: Request, meeting_id: int, version: int | None = None):
    """One meeting, the revision asked for, and what this account may do with it.

    `version` picks a revision to read, which for almost every meeting is the
    only one there is: approved minutes are immutable, so a second version can
    only exist on a database where one was started before that became the policy.
    Those are still readable — provenance for an answer given at the time — but
    nothing new can be written into them.

    A shared reader is shown the published minutes and may not ask for anything
    else: an unapproved draft has not been reviewed, and sharing grants a view of
    the approved minutes.

    Every personal field on the row — `display_title`, `alias`, `category_id`,
    `category_name` — is this account's own filing, joined per request. The
    canonical `title` is beside it, unchanged for everybody.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        role = access.require_read(user_id, meeting_id, c)
        owner = role == access.OWNER
        meeting = c.execute(
            f"SELECT m.*, {organization.COLUMNS},"
            f" o.display_name AS owner_display_name,"
            f" {PUBLISHED_VERSION} AS active_version,"
            f" {PUBLISHED_AT} AS version_published_at"
            f" FROM meetings m{organization.CATEGORY_JOIN}"
            f" LEFT JOIN users o ON o.id = m.owner_user_id"
            f" WHERE m.id = %(mid)s",
            access.params(user_id, {"mid": meeting_id}),
        ).fetchone()
        draft = versions.open_version(meeting_id, c)
        published = meeting["active_version"]
        # The one editable revision: version 1, while the meeting is still at the
        # review gate. After the first approval there is nothing to edit — see
        # `_editable_draft`, which refuses the writes on the same condition.
        editable = (
            draft["version"]
            if draft and draft["status"] == "DRAFT" and meeting["status"] == "REVIEW_REQUIRED"
            else None
        )

        if not owner:
            # A shared reader sees the approved minutes and only those. `version`
            # is ignored rather than refused, because there is nothing to choose
            # between: any other revision is either unapproved or withdrawn.
            wanted = published
        elif version is None:
            # Before the first approval, the draft being reviewed; after it, the
            # published minutes.
            wanted = published or (draft or {}).get("version")
        else:
            if not c.execute(
                "SELECT 1 FROM meeting_versions WHERE meeting_id = %s AND version = %s",
                (meeting_id, version),
            ).fetchone():
                raise HTTPException(404, "해당 버전을 찾을 수 없습니다.")
            wanted = version
        # A meeting that has neither published nor opened a revision cannot
        # exist (`create_meeting` opens version 1), but reading a transcript is
        # not the place to depend on that.
        wanted = wanted or versions.current(meeting_id, c)

        speakers = c.execute(
            "SELECT id, speaker_code, display_name FROM speakers WHERE meeting_id = %s "
            "ORDER BY speaker_code",
            (meeting_id,),
        ).fetchall()
        segments = c.execute(
            "SELECT t.sequence, t.start_time, t.end_time, t.text, s.speaker_code,"
            " s.display_name FROM transcript_segments t"
            " LEFT JOIN speakers s ON s.id = t.speaker_id"
            " WHERE t.meeting_id = %s AND t.version = %s ORDER BY t.sequence",
            (meeting_id, wanted),
        ).fetchall()
        mine = c.execute(
            "SELECT speaker_id FROM meeting_user_speakers"
            " WHERE meeting_id = %s AND user_id = %s",
            (meeting_id, user_id),
        ).fetchone()
        # Only the owner is told anything about sharing. To a shared reader the
        # other readers of a meeting are not their business, and the count alone
        # would say how widely somebody else's recording has been circulated.
        shared_with = c.execute(
            "SELECT count(*) AS n FROM meeting_shares"
            " WHERE meeting_id = %s AND status = 'ACCEPTED'",
            (meeting_id,),
        ).fetchone()["n"] if owner else None
    return {
        "meeting": meeting,
        "speakers": speakers,
        "segments": segments,
        "my_speaker_id": mine["speaker_id"] if mine else None,
        # The permission, computed by the server. The browser uses it to decide
        # what to draw; it is not what decides what is allowed.
        "role": role,
        "version": wanted,
        "active_version": published,
        # The revision this account may still edit, or null — which is what it
        # is for every approved meeting, and always for a shared reader.
        "draft_version": editable if owner else None,
        "shared_with": shared_with,
    }


@router.delete("/{meeting_id}")
def delete_meeting(request: Request, meeting_id: int):
    """Delete a meeting and everything it owns, whatever status it is in.

    The owner only. A shared reader gets 403 and a stranger gets 404 — the
    recording, the minutes, and everyone else's access to them all go, so this is
    the one action that must never be reachable by having been let in.

    `speakers`, `transcript_segments`, `chunks`, `meeting_facts`, and their
    participants are all ON DELETE CASCADE, so one statement closes the whole
    database lifecycle — no child deletes here.

    There is no status gate, and that is the policy every screen uses. A meeting
    can be stuck mid-analysis with nothing working on it (in-process background
    tasks do not survive a restart), and refusing to delete it would leave it on
    the list forever. What makes that safe is the other side: every write in
    `pipeline` and `intelligence` targets a meeting row by id, so a foreign key
    refuses it once the row is gone, and `pipeline.process` checks for the row
    before it persists a transcript and cleans up the audio it was holding when
    it has gone. The worst case is a task that finishes into nothing.

    `meeting_shares` and `meeting_versions` cascade with everything else, so a
    revoked reader's access disappears with the row rather than being cleaned up
    afterwards.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "삭제할", c)
        row = c.execute(
            "DELETE FROM meetings WHERE id = %s RETURNING stored_filename",
            (meeting_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")

    # Database first, on purpose. A failed unlink leaves a file nothing refers
    # to — wasted disk. The other order would leave a meeting row pointing at
    # audio that is already gone, which is a visibly broken meeting. The delete
    # is what the caller asked for, so a file that will not go is logged, not
    # raised: reporting failure for an already-deleted meeting would be a lie.
    for path in audio.meeting_files(row["stored_filename"]):
        try:
            path.unlink()
        except OSError as exc:
            log.warning("meeting %s: could not remove %s: %s", meeting_id, path, exc)
    return {"id": meeting_id, "deleted": True}


@router.get("/{meeting_id}/status")
def get_status(request: Request, meeting_id: int):
    with conn() as c:
        access.require_read(request.state.user["id"], meeting_id, c)
        row = c.execute(
            "SELECT id, status, error_message, duration, language FROM meetings WHERE id = %s",
            (meeting_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")
    return row


class SegmentEdit(BaseModel):
    sequence: int
    text: str | None = None
    speaker_id: int | None = None


class TranscriptEdit(BaseModel):
    segments: list[SegmentEdit]


def _editable_draft(c, meeting_id: int) -> int:
    """The revision the owner may edit right now, or 409 saying why not.

    Exactly one revision is ever editable: the draft of a meeting still sitting
    at the review gate. **Approved minutes are immutable.** Once a person has
    said these minutes are correct, the text is what every chunk, every fact,
    every stored citation, and every shared reader's answer rests on, and there
    is no path in the product that rewrites it.

    That is enforced here rather than by hiding a button: this function is the
    single gate in front of the transcript PATCH, the speaker rename, the
    correction suggestions, and the approval itself, so a request made directly
    against the API is refused by the same condition the screen was drawn from.

    FOR UPDATE holds both rows for this transaction, so a concurrent approval
    cannot claim the draft between this check and the writes that follow. Without
    it an edit could land after approval and be left out of the index while the
    meeting reported COMPLETED.
    """
    row = c.execute(
        "SELECT v.version FROM meeting_versions v JOIN meetings m ON m.id = v.meeting_id"
        " WHERE v.meeting_id = %s AND v.status = 'DRAFT'"
        "   AND m.status = 'REVIEW_REQUIRED'"
        " FOR UPDATE OF v, m",
        (meeting_id,),
    ).fetchone()
    if row:
        return row["version"]

    status = c.execute(
        "SELECT status FROM meetings WHERE id = %s", (meeting_id,)
    ).fetchone()["status"]
    if status == "COMPLETED":
        raise HTTPException(409, "승인된 회의록은 수정할 수 없습니다.")
    raise HTTPException(409, f"검토 단계에서만 수정할 수 있습니다. 현재 상태: {status}")


@router.patch("/{meeting_id}/transcript")
def edit_transcript(request: Request, meeting_id: int, body: TranscriptEdit):
    """Save reviewer corrections into the open draft. Owner only.

    Edits address a segment by (meeting, version, sequence), which is what the
    unique index in migration 009 guarantees is one row. A shared reader cannot
    reach this at all: reading approved minutes is not permission to change them,
    and a correction here would rewrite the evidence every other reader's answers
    are quoting.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "수정할", c)
        version = _editable_draft(c, meeting_id)

        updated = 0
        for seg in body.segments:
            # speaker_id is constrained to this meeting's own speakers, so an edit
            # can never point a segment at another meeting's speaker.
            row = c.execute(
                "UPDATE transcript_segments SET"
                "   text = COALESCE(%(text)s, text),"
                "   speaker_id = COALESCE("
                "     (SELECT s.id FROM speakers s"
                "       WHERE s.id = %(sid)s AND s.meeting_id = %(mid)s), speaker_id)"
                " WHERE meeting_id = %(mid)s AND version = %(ver)s AND sequence = %(seq)s"
                " RETURNING id",
                {
                    "text": seg.text.strip() if seg.text is not None else None,
                    "sid": seg.speaker_id,
                    "mid": meeting_id,
                    "ver": version,
                    "seq": seg.sequence,
                },
            ).fetchone()
            updated += 1 if row else 0
    return {"updated": updated, "version": version}


def _claim_for_indexing(meeting_id: int, from_status: str, action: str) -> None:
    """Atomically move the meeting from `from_status` into INDEXING, or refuse.

    The compare-and-set is what makes a repeated or concurrent request a no-op
    instead of a second indexing run: only one UPDATE can match, and every later
    one sees INDEXING and is rejected. PostgreSQL does the mutual exclusion.
    """
    with conn() as c:
        row = c.execute(
            "UPDATE meetings SET status = 'INDEXING', error_message = NULL"
            " WHERE id = %s AND status = %s RETURNING id",
            (meeting_id, from_status),
        ).fetchone()
        if row:
            return
        current = c.execute(
            "SELECT status FROM meetings WHERE id = %s", (meeting_id,)
        ).fetchone()
    if not current:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")
    raise HTTPException(
        409, f"{action}할 수 있는 상태가 아닙니다. 현재 상태: {current['status']}"
    )


@router.post("/{meeting_id}/approve")
def approve_meeting(request: Request, meeting_id: int, background: BackgroundTasks):
    """Human approval gate, and the one moment minutes stop being editable.

    A person says these minutes are correct: the meeting moves
    REVIEW_REQUIRED -> INDEXING -> COMPLETED, the revision is published, and from
    then on the transcript is fixed. A failure sends it back to the review gate,
    where it can be corrected and approved again.

    There is no second approval. `_editable_draft` refuses an approved meeting
    before anything here runs, so this only ever publishes a meeting's first
    revision — which is why the failure status is unconditional.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "승인할", c)
        version = _editable_draft(c, meeting_id)
        if versions.claim(meeting_id, c) is None:
            raise HTTPException(409, "이미 인덱싱 중입니다.")
        c.execute(
            "UPDATE meetings SET status = 'INDEXING', error_message = NULL WHERE id = %s",
            (meeting_id,),
        )
    background.add_task(pipeline.index_transcript, meeting_id, version, "REVIEW_REQUIRED")
    # A second task, and deliberately not part of the first: background tasks run
    # in order, so this only ever sees a meeting that actually reached COMPLETED,
    # and a failed extraction cannot undo an approval or its search index.
    background.add_task(intelligence.after_approval, meeting_id)
    return {"id": meeting_id, "status": "INDEXING", "version": version}


@router.post("/{meeting_id}/reindex")
def reindex_meeting(request: Request, meeting_id: int, background: BackgroundTasks):
    """Re-chunk and re-embed an approved meeting from its stored transcript.

    No audio is read: no FFmpeg, no STT, no diarization, no transcript or
    speaker rewrite. Only `chunks` changes. Use it after the chunking constants
    or the embedding model change, so an already-approved meeting can be brought
    onto the current index without a re-upload.

    Owner only, and always the published revision — never an open draft, which
    has not been approved. A draft may sit beside it untouched.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "재임베딩할", c)
        version = versions.published(meeting_id, c)
    _claim_for_indexing(meeting_id, "COMPLETED", "재임베딩")
    background.add_task(pipeline.index_transcript, meeting_id, version, "COMPLETED")
    return {"id": meeting_id, "status": "INDEXING", "version": version}


class SpeakerRename(BaseModel):
    display_name: str


@router.patch("/{meeting_id}/speakers/{speaker_id}")
def rename_speaker(request: Request, meeting_id: int, speaker_id: int, body: SpeakerRename):
    """Rename a speaker. Like transcript edits: owner only, open draft only.

    The published minutes are immutable: `chunks.content` renders display names at
    index time, so renaming while nothing is being revised would make the evidence
    text and the source label disagree with no path back to agreement. Inside a
    draft there is such a path — publishing it rebuilds the chunks — so the rename
    rides along with the correction it belongs to.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "수정할", c)
        _editable_draft(c, meeting_id)
        row = c.execute(
            "UPDATE speakers SET display_name = %s WHERE id = %s AND meeting_id = %s"
            " RETURNING id, speaker_code, display_name",
            (body.display_name.strip()[:100], speaker_id, meeting_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "화자를 찾을 수 없습니다.")
    return row


def _require_status(meeting_id: int, status: str, action: str) -> None:
    with conn() as c:
        row = c.execute("SELECT status FROM meetings WHERE id = %s", (meeting_id,)).fetchone()
    if not row:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")
    if row["status"] != status:
        raise HTTPException(
            409, f"{action}할 수 있는 상태가 아닙니다. 현재 상태: {row['status']}"
        )


def _run(fn, *args):
    """Call an OpenAI-backed helper and turn its failures into honest statuses."""
    try:
        return fn(*args)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        log.warning("assist call failed: %s", exc)
        raise HTTPException(502, f"AI 호출에 실패했습니다({type(exc).__name__}).") from exc


@router.get("/{meeting_id}/summary")
def get_summary(request: Request, meeting_id: int):
    access.require_read(request.state.user["id"], meeting_id)
    row = assist.get_summary(meeting_id)
    if not row:
        raise HTTPException(404, "아직 생성된 요약이 없습니다.")
    return row


@router.post("/{meeting_id}/summary")
def create_summary(request: Request, meeting_id: int):
    """Summarize the published transcript. Posting again regenerates and replaces.

    Approved only: a draft summary would carry the same authority as the reviewed
    one while resting on text nobody has checked. Owner only, because there is
    one summary per meeting — a shared reader regenerating it would rewrite what
    the owner and every other reader sees.
    """
    access.require_owner(request.state.user["id"], meeting_id, "요약을 만들")
    _require_status(meeting_id, "COMPLETED", "요약")
    return _run(assist.summarize, meeting_id)


@router.post("/{meeting_id}/corrections")
def suggest_corrections(request: Request, meeting_id: int):
    """Propose STT fixes for the open draft. Returns suggestions; writes nothing.

    Applying them is the reviewer's job — the browser puts the text into the
    editable transcript and the existing PATCH is what persists it. So this is
    offered exactly where that PATCH is: to the owner, on a draft.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "후보정할", c)
        version = _editable_draft(c, meeting_id)
    return {"suggestions": _run(assist.suggest_corrections, meeting_id, version)}


class MySpeaker(BaseModel):
    # null clears the mapping. One endpoint for both, because "which speaker am
    # I" and "I am not any of them" are the same question.
    speaker_id: int | None = None


@router.put("/{meeting_id}/me")
def set_my_speaker(request: Request, meeting_id: int, body: MySpeaker):
    """Say which diarized speaker the logged-in user is in this meeting.

    pyannote's SPEAKER_00 is a per-meeting label, never an account, so "내가
    요청한 것" needs this bridge. The user comes from the session and never from
    the body: a client cannot map somebody else. The database enforces the rest —
    a composite foreign key refuses a speaker belonging to another meeting, and
    the unique key refuses one another user has already claimed.

    Allowed after approval as well. This is identity, not transcript text: it
    changes no word of the approved minutes and so is not bound by that gate.

    A shared reader may map themselves too, and that is the point of keeping this
    separate from sharing: being given a meeting says nothing about whether you
    were in it. Until an account says which speaker it is, "내가 요청한 것" has
    no answer for that account in that meeting — see `rag.NO_IDENTITY`.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        access.require_read(user_id, meeting_id, c)
        if body.speaker_id is None:
            c.execute(
                "DELETE FROM meeting_user_speakers WHERE meeting_id = %s AND user_id = %s",
                (meeting_id, user_id),
            )
            return {"meeting_id": meeting_id, "speaker_id": None}
        try:
            row = c.execute(
                "INSERT INTO meeting_user_speakers (meeting_id, user_id, speaker_id)"
                " VALUES (%s,%s,%s)"
                " ON CONFLICT (meeting_id, user_id)"
                "   DO UPDATE SET speaker_id = EXCLUDED.speaker_id"
                " RETURNING speaker_id",
                (meeting_id, user_id, body.speaker_id),
            ).fetchone()
        except UniqueViolation as exc:
            raise HTTPException(409, "이미 다른 사용자가 지정한 화자입니다.") from exc
        except ForeignKeyViolation as exc:
            raise HTTPException(400, "이 회의의 화자가 아닙니다.") from exc
    return {"meeting_id": meeting_id, "speaker_id": row["speaker_id"]}


class HeldAt(BaseModel):
    # null clears it back to "nobody has said when this was held".
    held_at: dt.datetime | None = None


@router.put("/{meeting_id}/held-at")
def set_held_at(request: Request, meeting_id: int, body: HeldAt):
    """Record when the meeting actually took place.

    created_at is when the file was uploaded, which is the same thing only by
    accident. This is what cross-meeting ordering and relative deadlines use.

    Editable at any status: it is metadata about the meeting, not a word of the
    approved transcript. Deadlines already extracted keep the date they resolved
    to until the facts are rebuilt - the UI says so where the field is.

    Owner only. It is metadata about somebody else's meeting, and it moves that
    meeting in every reader's chronology and in relative deadline resolution.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "수정할", c)
        row = c.execute(
            "UPDATE meetings SET held_at = %s WHERE id = %s RETURNING id, held_at",
            (body.held_at, meeting_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")
    return row


class CategoryAssign(BaseModel):
    # null clears it back to 미분류.
    category_id: int | None = None


class AliasAssign(BaseModel):
    # null, or an empty string, goes back to the meeting's own title.
    alias: str | None = None


@router.put("/{meeting_id}/category")
def set_category(request: Request, meeting_id: int, body: CategoryAssign):
    """File the meeting in one of *this account's* categories, or unfile it.

    Read access, not ownership, and that is the whole point of migration 011: a
    filing is how one person arranged their own screen, so a shared reader files
    their copy without touching the owner's, and the owner never sees it. The
    canonical meeting is not written at all — this is a row in
    `user_meeting_filing` keyed on (account, meeting).

    The category must be one of the caller's own. The composite foreign key
    refuses anything else outright; `organization.owned` turns that into a
    sentence before the write.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        access.require_read(user_id, meeting_id, c)
        category_id = organization.owned(c, user_id, body.category_id)
        row = organization.file_meeting(c, user_id, meeting_id, category_id=category_id)
        name = c.execute(
            "SELECT name FROM user_categories WHERE id = %s", (category_id,)
        ).fetchone() if category_id else None
    return {
        "id": meeting_id,
        "category_id": row["category_id"],
        "category_name": name["name"] if name else None,
    }


@router.put("/{meeting_id}/alias")
def set_alias(request: Request, meeting_id: int, body: AliasAssign):
    """What this account calls the meeting on its own screens.

    Not a rename. `meetings.title` is the recording's name, set by the upload and
    changed by nobody, and it is still what every other account sees — an alias
    is one row in `user_meeting_filing`, read back through
    `organization.DISPLAY_TITLE` for this caller and nobody else.

    Read access, like the category: a shared reader labelling a meeting
    "면접 답변용 사례" is arranging their own list, not editing somebody's minutes.
    Clearing it returns to the canonical title rather than storing a copy of it,
    so the owner renaming the recording still reaches everyone who never chose a
    name of their own.
    """
    user_id = request.state.user["id"]
    alias = organization.clean_alias(body.alias)
    with conn() as c:
        access.require_read(user_id, meeting_id, c)
        row = organization.file_meeting(c, user_id, meeting_id, alias=alias)
        title = c.execute("SELECT title FROM meetings WHERE id = %s", (meeting_id,)).fetchone()
    return {
        "id": meeting_id,
        "alias": row["alias"],
        "display_title": row["alias"] or title["title"],
    }


@router.get("/{meeting_id}/intelligence")
def get_intelligence(request: Request, meeting_id: int):
    """State plus every stored fact, each with the segments it came from."""
    with conn() as c:
        access.require_read(request.state.user["id"], meeting_id, c)
        meeting = c.execute(
            "SELECT intelligence_state, intelligence_error FROM meetings WHERE id = %s",
            (meeting_id,),
        ).fetchone()
        if not meeting:
            raise HTTPException(404, "회의를 찾을 수 없습니다.")
        facts = c.execute(
            "SELECT f.id, f.fact_type, f.content, f.status, f.deadline_text, f.deadline_at,"
            " f.start_time, f.end_time, f.source_segment_ids, f.source_text,"
            " coalesce(jsonb_object_agg(p.role, coalesce(s.display_name, s.speaker_code))"
            "          FILTER (WHERE p.role IS NOT NULL), '{}'::jsonb) AS participants"
            " FROM meeting_facts f"
            " LEFT JOIN meeting_fact_participants p ON p.fact_id = f.id"
            " LEFT JOIN speakers s ON s.id = p.speaker_id"
            " WHERE f.meeting_id = %s"
            " GROUP BY f.id ORDER BY f.start_time, f.id",
            (meeting_id,),
        ).fetchall()
    return {
        "state": meeting["intelligence_state"],
        "error": meeting["intelligence_error"],
        "facts": facts,
    }


@router.post("/{meeting_id}/intelligence/rebuild")
def rebuild_intelligence(request: Request, meeting_id: int, background: BackgroundTasks):
    """Re-extract facts from the approved transcript. Approved meetings only.

    The compare-and-set inside `claim` is what makes a repeated click a no-op.
    Extraction and embedding both finish before anything is deleted, so a failure
    leaves the facts already stored exactly where they were.

    Owner only, for the same reason as the summary: there is one set of facts per
    meeting and every reader retrieves from it.
    """
    access.require_owner(request.state.user["id"], meeting_id, "정보를 생성할")
    _require_status(meeting_id, "COMPLETED", "정보 생성")
    if not config.OPENAI_API_KEY:
        raise HTTPException(400, "OPENAI_API_KEY가 설정되지 않았습니다.")
    if not intelligence.claim(meeting_id):
        raise HTTPException(409, "이미 정보를 생성하는 중입니다.")
    background.add_task(intelligence.run_build, meeting_id)
    return {"id": meeting_id, "state": "BUILDING"}
