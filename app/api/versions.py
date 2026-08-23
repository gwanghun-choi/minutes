"""Reading the revision history of a set of minutes.

Approved minutes are immutable. There is no endpoint here that creates a
revision or throws one away, because the product has no such action: a meeting
is corrected before it is approved, and after that the transcript is what every
chunk, fact, and stored citation rests on.

What remains is provenance, and it is read-only. `meeting_versions` and the
per-version `transcript_segments` are kept — a database that ran an earlier build
may hold a second revision, and an answer given at the time cites the words that
were published then. This router is how those are still readable.
"""
from fastapi import APIRouter, HTTPException, Request

from app.db import conn
from app.services import access, versions

router = APIRouter(prefix="/api/meetings/{meeting_id}/versions", tags=["versions"])


@router.get("")
def list_versions(request: Request, meeting_id: int):
    """Every revision, newest first. Read access, not ownership.

    A shared reader is shown the history because it answers a question they
    genuinely have — "these minutes changed, when?" — and it carries no
    unpublished text: the rows are numbers, statuses, and timestamps.
    """
    with conn() as c:
        access.require_read(request.state.user["id"], meeting_id, c)
        return {
            "versions": versions.history(meeting_id, c),
            "active_version": versions.published(meeting_id, c),
        }


@router.get("/{version}")
def get_version(request: Request, meeting_id: int, version: int):
    """One revision's transcript, read-only.

    The owner may read any of them, including superseded ones — that is what
    keeps an answer given before a correction checkable against the words it
    actually rested on. A shared reader may read the published one only.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        role = access.require_read(user_id, meeting_id, c)
        if role != access.OWNER and version != versions.published(meeting_id, c):
            raise HTTPException(404, "해당 버전을 찾을 수 없습니다.")
        row = c.execute(
            "SELECT version, status, created_at, published_at FROM meeting_versions"
            " WHERE meeting_id = %s AND version = %s",
            (meeting_id, version),
        ).fetchone()
        if not row:
            raise HTTPException(404, "해당 버전을 찾을 수 없습니다.")
        segments = c.execute(
            "SELECT t.sequence, t.start_time, t.end_time, t.text, s.speaker_code,"
            " s.display_name FROM transcript_segments t"
            " LEFT JOIN speakers s ON s.id = t.speaker_id"
            " WHERE t.meeting_id = %s AND t.version = %s ORDER BY t.sequence",
            (meeting_id, version),
        ).fetchall()
    return {**row, "segments": segments}
