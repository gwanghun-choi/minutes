"""Finding an account to invite.

The only reason this exists: a share stores `users.id`, and a person types a
name. Nothing else in the product needs a user directory, so there is no user
management here — no create, no update, no deactivate, no listing.

It answers a search and never a browse. An empty query returns nothing rather
than the whole staff list, the caller's own account is left out because inviting
yourself is refused anyway, and the reply carries only what the picker has to
show to tell two people apart.
"""
from fastapi import APIRouter, Request

from app.db import conn
from app.services import access

router = APIRouter(prefix="/api/users", tags=["users"])

LIMIT = 10


@router.get("")
def search_users(request: Request, q: str = "", meeting_id: int | None = None):
    """Accounts whose username or display name contains `q`.

    `meeting_id` is optional and is only a convenience for the invite dialog: it
    marks who already has an invitation so the picker can say so instead of
    letting the owner click into a 409. It is checked for ownership, because
    otherwise it would answer "who has meeting 42" for any id a caller guessed.
    """
    term = q.strip()
    if not term:
        return []
    if meeting_id is not None:
        access.require_owner(request.state.user["id"], meeting_id, "공유 관리를 할")
    with conn() as c:
        return c.execute(
            "SELECT u.id, u.username, u.display_name,"
            " (SELECT sh.status FROM meeting_shares sh"
            "   WHERE sh.meeting_id = %(mid)s AND sh.invited_user_id = u.id) AS share_status"
            " FROM users u"
            " WHERE u.is_active AND u.id <> %(me)s"
            "   AND (u.username ILIKE %(q)s OR u.display_name ILIKE %(q)s)"
            " ORDER BY u.display_name, u.username LIMIT %(limit)s",
            {
                "q": f"%{term}%",
                "me": request.state.user["id"],
                "mid": meeting_id,
                "limit": LIMIT,
            },
        ).fetchall()
