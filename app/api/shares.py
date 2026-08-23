"""Sharing a meeting: the owner invites, the invited person answers.

Two routers, because there are two sides and they belong to different resources:

    /api/meetings/{id}/shares   the owner's view — who has this meeting
    /api/share-invitations      the invited person's view — what I have been sent

A share is never a link and never a password. It names one account by id, that
account has to accept it, and the owner can take it back — at which point the
meeting disappears from their list, their detail page, and their retrieval scope
on the next request, because all three read `access.READABLE`.

Nothing here grants more than reading. There is no permission level to choose,
so there is no way to accidentally hand out editing.
"""
from fastapi import APIRouter, HTTPException, Request
from psycopg.errors import CheckViolation, ForeignKeyViolation
from pydantic import BaseModel

from app.db import conn
from app.services import access

router = APIRouter(prefix="/api/meetings", tags=["shares"])
inbox = APIRouter(prefix="/api/share-invitations", tags=["shares"])

# Only an approved, indexed meeting can be shared.
#
# Not a policy preference: a draft is unreviewed AI output, and handing it to
# somebody else publishes a transcript nobody has checked under the same UI that
# presents approved minutes. It is also the only status whose chunks and facts
# match what the screen shows, so a shared reader's search results and their
# transcript agree.
SHAREABLE_STATUS = "COMPLETED"


class Invite(BaseModel):
    # An account id, never a name. The picker searches by name; what it sends,
    # and what the row stores, is the identity behind that name.
    user_id: int


def _rows(c, meeting_id: int) -> list[dict]:
    return c.execute(
        "SELECT sh.id, sh.invited_user_id, sh.status, sh.created_at, sh.responded_at,"
        " sh.revoked_at, u.username, u.display_name"
        " FROM meeting_shares sh JOIN users u ON u.id = sh.invited_user_id"
        " WHERE sh.meeting_id = %s ORDER BY sh.created_at DESC, sh.id DESC",
        (meeting_id,),
    ).fetchall()


@router.get("/{meeting_id}/shares")
def list_shares(request: Request, meeting_id: int):
    """Everyone this meeting has been offered to, and where each of them got to.

    Owner only. Who else can read a recording is the owner's business, and to a
    shared reader even the number would say how widely it has been circulated.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "공유 관리를 할", c)
        return _rows(c, meeting_id)


@router.post("/{meeting_id}/shares")
def create_share(request: Request, meeting_id: int, body: Invite):
    """Invite one account to read this meeting.

    Re-inviting somebody who refused, or somebody whose share was taken back,
    reopens the same row as PENDING rather than adding a second one — a person is
    either invited to a meeting or not, and two rows would make "may they read
    it" a question about which row wins. The timestamps keep the history.

    Re-inviting somebody who has already accepted is a 409, not a silent reset:
    it would put a reader who already has the meeting back into a pending state
    they never asked to return to.

    The database refuses the rest. `meeting_shares_not_self` refuses inviting
    yourself, the foreign key refuses an account that does not exist, and the
    unique key is what makes the upsert below a single row.
    """
    owner_id = request.state.user["id"]
    with conn() as c:
        access.require_owner(owner_id, meeting_id, "공유할", c)
        status = c.execute(
            "SELECT status FROM meetings WHERE id = %s", (meeting_id,)
        ).fetchone()["status"]
        if status != SHAREABLE_STATUS:
            raise HTTPException(
                409,
                "승인이 끝난 회의만 공유할 수 있습니다. "
                f"현재 상태: {status}",
            )
        existing = c.execute(
            "SELECT status FROM meeting_shares WHERE meeting_id = %s AND invited_user_id = %s",
            (meeting_id, body.user_id),
        ).fetchone()
        if existing and existing["status"] == "PENDING":
            raise HTTPException(409, "이미 초대한 사용자입니다.")
        if existing and existing["status"] == "ACCEPTED":
            raise HTTPException(409, "이미 공유 중인 사용자입니다.")
        try:
            return c.execute(
                "INSERT INTO meeting_shares (meeting_id, invited_user_id, invited_by_user_id)"
                " VALUES (%s,%s,%s)"
                " ON CONFLICT (meeting_id, invited_user_id) DO UPDATE"
                "   SET status = 'PENDING', invited_by_user_id = EXCLUDED.invited_by_user_id,"
                "       created_at = now(), responded_at = NULL, revoked_at = NULL"
                " RETURNING id, invited_user_id, status, created_at",
                (meeting_id, body.user_id, owner_id),
            ).fetchone()
        except CheckViolation as exc:
            raise HTTPException(400, "자기 자신을 초대할 수 없습니다.") from exc
        except ForeignKeyViolation as exc:
            raise HTTPException(400, "존재하지 않는 사용자입니다.") from exc


@router.delete("/{meeting_id}/shares/{user_id}")
def revoke_share(request: Request, meeting_id: int, user_id: int):
    """Take a share back, whether it was accepted or still pending.

    The row is kept as REVOKED rather than deleted, so the database can still say
    who had this meeting and when it was withdrawn. Access ends immediately and
    everywhere at once, because nothing caches it: `access.READABLE` only counts
    an ACCEPTED row, and the list, the detail page, the transcript, the sources,
    and all four retrieval paths evaluate that predicate on every request.
    """
    with conn() as c:
        access.require_owner(request.state.user["id"], meeting_id, "공유 해제를 할", c)
        row = c.execute(
            "UPDATE meeting_shares SET status = 'REVOKED', revoked_at = now()"
            " WHERE meeting_id = %s AND invited_user_id = %s AND status <> 'REVOKED'"
            " RETURNING id, invited_user_id, status",
            (meeting_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "공유 내역을 찾을 수 없습니다.")
    return row


@inbox.get("")
def list_invitations(request: Request):
    """What has been offered to me, newest first. PENDING only.

    A refused or withdrawn invitation is not an inbox item, and an accepted one
    is a meeting — it belongs on the 공유받은 회의 list, not here.
    """
    with conn() as c:
        return c.execute(
            "SELECT sh.id, sh.meeting_id, sh.created_at,"
            " m.title AS meeting_title, coalesce(m.held_at, m.created_at) AS occurred_at,"
            " m.held_at IS NOT NULL AS held_at_known,"
            " u.display_name AS shared_by"
            " FROM meeting_shares sh"
            " JOIN meetings m ON m.id = sh.meeting_id"
            " JOIN users u ON u.id = sh.invited_by_user_id"
            " WHERE sh.invited_user_id = %s AND sh.status = 'PENDING'"
            " ORDER BY sh.created_at DESC, sh.id DESC",
            (request.state.user["id"],),
        ).fetchall()


def _respond(user_id: int, share_id: int, status: str) -> dict:
    """Answer one invitation. The account is the predicate, so somebody else's
    invitation id is a 404 rather than a decision made on their behalf."""
    with conn() as c:
        row = c.execute(
            "UPDATE meeting_shares SET status = %s, responded_at = now()"
            " WHERE id = %s AND invited_user_id = %s AND status = 'PENDING'"
            " RETURNING id, meeting_id, status",
            (status, share_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "처리할 수 있는 초대가 없습니다.")
    return row


@inbox.post("/{share_id}/accept")
def accept_invitation(request: Request, share_id: int):
    return _respond(request.state.user["id"], share_id, "ACCEPTED")


@inbox.post("/{share_id}/reject")
def reject_invitation(request: Request, share_id: int):
    """Refuse. The owner can invite again later, which reopens this same row."""
    return _respond(request.state.user["id"], share_id, "REJECTED")
