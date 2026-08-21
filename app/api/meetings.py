import datetime as dt
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from psycopg.errors import ForeignKeyViolation, UniqueViolation
from pydantic import BaseModel

from app import config
from app.db import conn
from app.services import assist, audio, intelligence, pipeline

log = logging.getLogger("minutes.api")
router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# A background task holds the audio and writes the meeting's rows, so a meeting
# is only removable once nothing is running against it. UPLOADED is excluded for
# the same reason: process() is already scheduled by the time the row exists.
DELETABLE_STATUSES = ["REVIEW_REQUIRED", "COMPLETED", "FAILED"]


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

    with conn() as c:
        row = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status, held_at) "
            "VALUES (%s,%s,%s,'UPLOADED',%s) RETURNING id, title, status, created_at, held_at",
            (title.strip() or Path(file.filename).stem, file.filename, stored, held),
        ).fetchone()

    background.add_task(pipeline.process, row["id"], str(dest))
    return row


@router.get("")
def list_meetings():
    with conn() as c:
        return c.execute(
            """
            SELECT m.*, k.name AS category_name,
                   (SELECT count(*) FROM speakers s WHERE s.meeting_id = m.id) AS speaker_count
            FROM meetings m
            LEFT JOIN meeting_categories k ON k.id = m.category_id
            ORDER BY m.id DESC
            """
        ).fetchall()


@router.get("/{meeting_id}")
def get_meeting(request: Request, meeting_id: int):
    with conn() as c:
        meeting = c.execute(
            "SELECT m.*, k.name AS category_name FROM meetings m"
            " LEFT JOIN meeting_categories k ON k.id = m.category_id"
            " WHERE m.id = %s",
            (meeting_id,),
        ).fetchone()
        if not meeting:
            raise HTTPException(404, "회의를 찾을 수 없습니다.")
        speakers = c.execute(
            "SELECT id, speaker_code, display_name FROM speakers WHERE meeting_id = %s "
            "ORDER BY speaker_code",
            (meeting_id,),
        ).fetchall()
        segments = c.execute(
            "SELECT t.sequence, t.start_time, t.end_time, t.text, s.speaker_code,"
            " s.display_name FROM transcript_segments t"
            " LEFT JOIN speakers s ON s.id = t.speaker_id"
            " WHERE t.meeting_id = %s ORDER BY t.sequence",
            (meeting_id,),
        ).fetchall()
        mine = c.execute(
            "SELECT speaker_id FROM meeting_user_speakers"
            " WHERE meeting_id = %s AND user_id = %s",
            (meeting_id, request.state.user["id"]),
        ).fetchone()
    return {
        "meeting": meeting,
        "speakers": speakers,
        "segments": segments,
        "my_speaker_id": mine["speaker_id"] if mine else None,
    }


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: int):
    """Delete a meeting and everything it owns.

    `speakers`, `transcript_segments`, and `chunks` are all ON DELETE CASCADE, so
    one statement closes the whole database lifecycle — no child deletes here.
    The status predicate sits inside the DELETE, so the row cannot be removed
    between a check and the delete.
    """
    with conn() as c:
        row = c.execute(
            "DELETE FROM meetings WHERE id = %s AND status = ANY(%s)"
            " RETURNING stored_filename",
            (meeting_id, DELETABLE_STATUSES),
        ).fetchone()
        if not row:
            current = c.execute(
                "SELECT status FROM meetings WHERE id = %s", (meeting_id,)
            ).fetchone()
    if not row:
        if not current:
            raise HTTPException(404, "회의를 찾을 수 없습니다.")
        raise HTTPException(
            409, f"분석이 진행 중이어서 삭제할 수 없습니다. 현재 상태: {current['status']}"
        )

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
def get_status(meeting_id: int):
    with conn() as c:
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


@router.patch("/{meeting_id}/transcript")
def edit_transcript(meeting_id: int, body: TranscriptEdit):
    """Save reviewer corrections. Only while the meeting sits at the review gate."""
    with conn() as c:
        # FOR UPDATE holds the meeting row for this transaction, so a concurrent
        # approval cannot flip the status to INDEXING between this check and the
        # writes below. Without it an edit could land after approval and be
        # excluded from the index while the meeting reported COMPLETED.
        meeting = c.execute(
            "SELECT status FROM meetings WHERE id = %s FOR UPDATE", (meeting_id,)
        ).fetchone()
        if not meeting:
            raise HTTPException(404, "회의를 찾을 수 없습니다.")
        if meeting["status"] != "REVIEW_REQUIRED":
            raise HTTPException(
                409, f"검토 단계에서만 수정할 수 있습니다. 현재 상태: {meeting['status']}"
            )

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
                " WHERE meeting_id = %(mid)s AND sequence = %(seq)s RETURNING id",
                {
                    "text": seg.text.strip() if seg.text is not None else None,
                    "sid": seg.speaker_id,
                    "mid": meeting_id,
                    "seq": seg.sequence,
                },
            ).fetchone()
            updated += 1 if row else 0
    return {"updated": updated}


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
def approve_meeting(meeting_id: int, background: BackgroundTasks):
    """Human approval gate. This is the only path that starts a first indexing."""
    _claim_for_indexing(meeting_id, "REVIEW_REQUIRED", "승인")
    background.add_task(pipeline.index_transcript, meeting_id)
    # A second task, and deliberately not part of the first: background tasks run
    # in order, so this only ever sees a meeting that actually reached COMPLETED,
    # and a failed extraction cannot undo an approval or its search index.
    background.add_task(intelligence.after_approval, meeting_id)
    return {"id": meeting_id, "status": "INDEXING"}


@router.post("/{meeting_id}/reindex")
def reindex_meeting(meeting_id: int, background: BackgroundTasks):
    """Re-chunk and re-embed an approved meeting from its stored transcript.

    No audio is read: no FFmpeg, no STT, no diarization, no transcript or
    speaker rewrite. Only `chunks` changes. Use it after the chunking constants
    or the embedding model change, so an already-approved meeting can be brought
    onto the current index without a re-upload.
    """
    _claim_for_indexing(meeting_id, "COMPLETED", "재임베딩")
    background.add_task(pipeline.index_transcript, meeting_id, on_failure="COMPLETED")
    return {"id": meeting_id, "status": "INDEXING"}


class SpeakerRename(BaseModel):
    display_name: str


@router.patch("/{meeting_id}/speakers/{speaker_id}")
def rename_speaker(meeting_id: int, speaker_id: int, body: SpeakerRename):
    """Rename a speaker. Like transcript edits, only at the review gate.

    An approved transcript is immutable: `chunks.content` renders display names at
    index time, so a later rename would make the evidence text and the source
    label disagree.
    """
    with conn() as c:
        # The status predicate is inside the UPDATE, so it cannot be raced by a
        # concurrent approval.
        row = c.execute(
            "UPDATE speakers SET display_name = %s"
            " WHERE id = %s AND meeting_id = %s"
            "   AND EXISTS (SELECT 1 FROM meetings m"
            "                WHERE m.id = %s AND m.status = 'REVIEW_REQUIRED')"
            " RETURNING id, speaker_code, display_name",
            (body.display_name.strip()[:100], speaker_id, meeting_id, meeting_id),
        ).fetchone()
        if not row:
            meeting = c.execute(
                "SELECT status FROM meetings WHERE id = %s", (meeting_id,)
            ).fetchone()
    if not row:
        if meeting and meeting["status"] != "REVIEW_REQUIRED":
            raise HTTPException(
                409, f"검토 단계에서만 수정할 수 있습니다. 현재 상태: {meeting['status']}"
            )
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
def get_summary(meeting_id: int):
    row = assist.get_summary(meeting_id)
    if not row:
        raise HTTPException(404, "아직 생성된 요약이 없습니다.")
    return row


@router.post("/{meeting_id}/summary")
def create_summary(meeting_id: int):
    """Summarize the approved transcript. Posting again regenerates and replaces.

    Approved only: a draft summary would carry the same authority as the reviewed
    one while resting on text nobody has checked.
    """
    _require_status(meeting_id, "COMPLETED", "요약")
    return _run(assist.summarize, meeting_id)


@router.post("/{meeting_id}/corrections")
def suggest_corrections(meeting_id: int):
    """Propose STT fixes for a draft. Returns suggestions; writes nothing.

    Applying them is the reviewer's job — the browser puts the text into the
    editable transcript and the existing PATCH is what persists it.
    """
    _require_status(meeting_id, "REVIEW_REQUIRED", "후보정")
    return {"suggestions": _run(assist.suggest_corrections, meeting_id)}


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
    """
    user_id = request.state.user["id"]
    with conn() as c:
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
def set_held_at(meeting_id: int, body: HeldAt):
    """Record when the meeting actually took place.

    created_at is when the file was uploaded, which is the same thing only by
    accident. This is what cross-meeting ordering and relative deadlines use.

    Editable at any status: it is metadata about the meeting, not a word of the
    approved transcript. Deadlines already extracted keep the date they resolved
    to until the facts are rebuilt - the UI says so where the field is.
    """
    with conn() as c:
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


@router.put("/{meeting_id}/category")
def set_category(meeting_id: int, body: CategoryAssign):
    """Put the meeting in a category, or take it out of one.

    Like held-at, this is metadata about the meeting rather than a word of the
    approved transcript, so it is editable at any status. The foreign key is what
    refuses an id that is not a real category — nothing here looks it up first.
    """
    try:
        with conn() as c:
            row = c.execute(
                "UPDATE meetings m SET category_id = %s WHERE m.id = %s"
                " RETURNING m.id, m.category_id,"
                " (SELECT k.name FROM meeting_categories k WHERE k.id = m.category_id)"
                "   AS category_name",
                (body.category_id, meeting_id),
            ).fetchone()
    except ForeignKeyViolation as exc:
        raise HTTPException(400, "없는 카테고리입니다.") from exc
    if not row:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")
    return row


@router.get("/{meeting_id}/intelligence")
def get_intelligence(meeting_id: int):
    """State plus every stored fact, each with the segments it came from."""
    with conn() as c:
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
def rebuild_intelligence(meeting_id: int, background: BackgroundTasks):
    """Re-extract facts from the approved transcript. Approved meetings only.

    The compare-and-set inside `claim` is what makes a repeated click a no-op.
    Extraction and embedding both finish before anything is deleted, so a failure
    leaves the facts already stored exactly where they were.
    """
    _require_status(meeting_id, "COMPLETED", "정보 생성")
    if not config.OPENAI_API_KEY:
        raise HTTPException(400, "OPENAI_API_KEY가 설정되지 않았습니다.")
    if not intelligence.claim(meeting_id):
        raise HTTPException(409, "이미 정보를 생성하는 중입니다.")
    background.add_task(intelligence.run_build, meeting_id)
    return {"id": meeting_id, "state": "BUILDING"}
