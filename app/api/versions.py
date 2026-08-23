"""Revising approved minutes.

Correcting a published transcript is not an edit — it is a new version. This
router is the three things a person does with one: start it, look at the history,
throw it away. Approving it is `POST /api/meetings/{id}/approve`, because that is
the same act as approving the first draft and there is no reason for two buttons
that both mean "these minutes are correct".

Owner only, all of it. A shared reader reads the published minutes; revising
them is the owner's job, and there is no version-level permission to grant.
"""
from fastapi import APIRouter, HTTPException, Request
from psycopg.errors import UniqueViolation

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


@router.post("")
def create_version(request: Request, meeting_id: int):
    """Start a revision from the published minutes.

    The published transcript is copied into a new version and the published one
    is not touched — same rows, same chunks, same facts, same answers to every
    question, for the whole time the draft is open. That is the requirement this
    endpoint exists to meet: correcting minutes must not take them out of search
    while the correction is being written.

    Refused when a revision is already open. The partial unique index in
    migration 009 is what actually enforces it, so two simultaneous clicks cannot
    fork the minutes; the check here only turns the refusal into a sentence.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        access.require_owner(user_id, meeting_id, "수정할", c)
        if versions.published(meeting_id, c) is None:
            raise HTTPException(
                409, "아직 승인된 회의록이 없습니다. 먼저 초안을 검토하고 승인해 주세요."
            )
        if open_now := versions.open_version(meeting_id, c):
            raise HTTPException(
                409,
                f"이미 v{open_now['version']} 수정본이 열려 있습니다. "
                "그 버전을 승인하거나 삭제한 뒤 다시 시작해 주세요.",
            )
    try:
        version = versions.create_draft(meeting_id, user_id)
    except UniqueViolation as exc:
        raise HTTPException(409, "이미 수정 중인 버전이 있습니다.") from exc
    return {"meeting_id": meeting_id, "version": version, "status": "DRAFT"}


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


@router.delete("/{version}")
def discard_version(request: Request, meeting_id: int, version: int):
    """Abandon an unapproved revision.

    Only a DRAFT above version 1: version 1 is the meeting's only minutes and
    discarding it would leave a meeting with no transcript. Nothing published is
    touched, because a draft never touched it — so this is the way out of a
    revision started by mistake, and it costs the published version nothing.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "수정 취소를 할", c)
    if not versions.discard(meeting_id, version):
        raise HTTPException(409, "삭제할 수 있는 수정본이 아닙니다.")
    return {"meeting_id": meeting_id, "version": version, "deleted": True}
