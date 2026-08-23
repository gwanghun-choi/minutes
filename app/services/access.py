"""Who may read a meeting, and who may change it.

One rule, written once, in SQL:

    a meeting is readable by its owner, and by an account that has ACCEPTED an
    invitation to it. Nobody else, including an account with a PENDING or a
    REVOKED share, and including everybody when the meeting has no owner.

`READABLE` is that sentence as a predicate over a `meetings m` alias. Every list
query, every detail read, and all four retrieval paths paste the same text, so
"may this account see this meeting" cannot come to mean two different things —
the same discipline `categories.SUBTREE` applies to "descendant".

There are exactly two roles and no matrix:

    OWNER        read, chat, edit, approve, delete, share, revoke, reindex
    SHARED_READ  read and chat, and nothing else

Ownership is not transferable and a shared reader cannot re-share, so a
permission can only ever come from the one account that uploaded the audio.
"""
from fastapi import HTTPException

from app.db import conn

OWNER = "OWNER"
SHARED_READ = "SHARED_READ"

# The scope predicate. `m` is a `meetings` alias and `%(auth_uid)s` is the
# logged-in account; the parameter is named for what it is so it can never
# collide with a caller's own placeholder.
#
# `m.owner_user_id = %(auth_uid)s` is NULL-safe by being an ordinary equality: a
# meeting whose owner column is NULL (one that predates migration 009 and whose
# uploader the backfill could not prove) matches nobody. Orphans are invisible
# rather than public, which is the direction a missing answer has to fail in.
READABLE = """(
        m.owner_user_id = %(auth_uid)s
     OR EXISTS (SELECT 1 FROM meeting_shares sh
                 WHERE sh.meeting_id = m.id
                   AND sh.invited_user_id = %(auth_uid)s
                   AND sh.status = 'ACCEPTED')
)"""

# The same rule split by where the permission came from, for the two tabs the
# meeting list offers. Together they are exactly `READABLE`.
MINE = "m.owner_user_id = %(auth_uid)s"
SHARED = """EXISTS (SELECT 1 FROM meeting_shares sh
                     WHERE sh.meeting_id = m.id
                       AND sh.invited_user_id = %(auth_uid)s
                       AND sh.status = 'ACCEPTED')"""

SCOPES = {"": READABLE, "mine": MINE, "shared": SHARED}


def params(user_id: int, extra: dict | None = None) -> dict:
    """Bind the predicate's account, alongside a query's own parameters."""
    return {**(extra or {}), "auth_uid": user_id}


def role(user_id: int, meeting_id: int, c=None) -> str | None:
    """OWNER, SHARED_READ, or None when the account may not read this meeting.

    `c` reuses an open connection so a caller already inside a transaction does
    not check permission against a different snapshot from the one it acts on.
    """
    sql = (
        "SELECT CASE WHEN m.owner_user_id = %(auth_uid)s THEN 'OWNER'"
        "            WHEN " + SHARED + " THEN 'SHARED_READ' END AS role"
        " FROM meetings m WHERE m.id = %(mid)s AND " + READABLE
    )
    args = params(user_id, {"mid": meeting_id})
    if c is not None:
        row = c.execute(sql, args).fetchone()
    else:
        with conn() as c2:
            row = c2.execute(sql, args).fetchone()
    return row["role"] if row else None


def require_read(user_id: int, meeting_id: int, c=None) -> str:
    """-> the caller's role, or 404.

    404 and not 403: a meeting this account may not read must be
    indistinguishable from one that does not exist, or the id itself becomes a
    way to discover that somebody else has a meeting by that number.
    """
    found = role(user_id, meeting_id, c)
    if not found:
        raise HTTPException(404, "회의를 찾을 수 없습니다.")
    return found


def require_owner(user_id: int, meeting_id: int, action: str, c=None) -> None:
    """Owner-only actions. 404 when unreadable, 403 when merely not the owner.

    A shared reader already knows the meeting exists, so 403 tells them nothing
    new and says the true reason. Everyone else still gets 404.
    """
    if require_read(user_id, meeting_id, c) != OWNER:
        raise HTTPException(403, f"공유받은 회의는 {action} 수 없습니다. 소유자만 가능합니다.")


def visible(user_id: int, meeting_ids: list[int]) -> list[int]:
    """The subset of `meeting_ids` this account may read, in the order given.

    Used where a client names meetings — the chat scope. Intersecting rather than
    refusing is what keeps a conversation working after the owner revokes one of
    the meetings it was scoped to; the caller decides what an empty result means.
    """
    if not meeting_ids:
        return []
    with conn() as c:
        allowed = {
            r["id"]
            for r in c.execute(
                f"SELECT m.id FROM meetings m WHERE m.id = ANY(%(ids)s) AND {READABLE}",
                params(user_id, {"ids": list(meeting_ids)}),
            ).fetchall()
        }
    return [i for i in meeting_ids if i in allowed]
