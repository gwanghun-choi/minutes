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


class SpeakerRename(BaseModel):
    display_name: str


@router.patch("/{meeting_id}/speakers/{speaker_id}")
def rename_speaker(meeting_id: int, speaker_id: int, body: SpeakerRename):
    with conn() as c:
        row = c.execute(
            "UPDATE speakers SET display_name = %s WHERE id = %s AND meeting_id = %s "
            "RETURNING id, speaker_code, display_name",
            (body.display_name.strip()[:100], speaker_id, meeting_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "화자를 찾을 수 없습니다.")
    return row
