import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app import config
from app.db import conn
from app.services import pipeline

router = APIRouter(prefix="/api/meetings", tags=["meetings"])


@router.post("")
async def create_meeting(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form(""),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in config.ALLOWED_EXT:
        raise HTTPException(400, f"지원하지 않는 형식입니다: {ext or '(없음)'}")

    stored = f"{uuid.uuid4().hex}{ext}"
    dest = config.UPLOAD_DIR / stored
    with dest.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            fh.write(chunk)

    with conn() as c:
        row = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status) "
            "VALUES (%s,%s,%s,'UPLOADED') RETURNING id, title, status, created_at",
            (title.strip() or Path(file.filename).stem, file.filename, stored),
        ).fetchone()

    background.add_task(pipeline.process, row["id"], str(dest))
    return row


@router.get("")
def list_meetings():
    with conn() as c:
        return c.execute(
            """
            SELECT m.*, (SELECT count(*) FROM speakers s WHERE s.meeting_id = m.id) AS speaker_count
            FROM meetings m ORDER BY m.id DESC
            """
        ).fetchall()


@router.get("/{meeting_id}")
def get_meeting(meeting_id: int):
    with conn() as c:
        meeting = c.execute("SELECT * FROM meetings WHERE id = %s", (meeting_id,)).fetchone()
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
    return {"meeting": meeting, "speakers": speakers, "segments": segments}


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
