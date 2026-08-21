"""POC identity: username + password, opaque server-side sessions.

No JWT, no OAuth, no roles, no per-meeting permission. The only boundary this
draws is which chat sessions a request may touch.

The cookie carries a random token that means nothing on its own — `auth_sessions`
is the entire authority. That is what makes logout a DELETE and a forged or
edited cookie simply unresolvable, with no signing secret to configure or leak.
"""
import hashlib
import hmac
import secrets
from functools import lru_cache

from app.db import conn

COOKIE_NAME = "minutes_session"
SESSION_DAYS = 7
# 128 * n * r = 16 MiB per hash: enough to make offline guessing expensive,
# small enough that a login stays well under a second on the deployment CPU.
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    """scrypt from the stdlib. Parameters travel with the hash so they can change."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt),
            n=int(n), r=int(r), p=int(p), dklen=len(digest) // 2,
        )
    except ValueError:
        return False
    return hmac.compare_digest(dk.hex(), digest)


@lru_cache(maxsize=1)
def _decoy() -> str:
    """A hash of nothing, used so an unknown username costs the same as a known one."""
    return hash_password(secrets.token_urlsafe(16))


def authenticate(username: str, password: str) -> dict | None:
    """The account row is the only source of truth. Deactivated is refused here too."""
    with conn() as c:
        row = c.execute(
            "SELECT id, username, display_name, password_hash, is_active"
            " FROM users WHERE username = %s",
            (username,),
        ).fetchone()
    if not row or not row["is_active"]:
        # keep the timing flat, so neither answer reveals which usernames exist
        verify_password(password, row["password_hash"] if row else _decoy())
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    with conn() as c:
        c.execute("UPDATE users SET last_login_at = now() WHERE id = %s", (row["id"],))
    return {
        "id": row["id"], "username": row["username"], "display_name": row["display_name"]
    }


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with conn() as c:
        c.execute("INSERT INTO auth_sessions (id, user_id) VALUES (%s,%s)", (token, user_id))
    return token


def resolve_session(token: str | None) -> dict | None:
    """The token -> the user, or None.

    Age and `is_active` are both checked in SQL: deactivating an account has to
    close the sessions it already handed out, and the cheapest place to enforce
    that is the query every request already runs.
    """
    if not token:
        return None
    with conn() as c:
        return c.execute(
            "SELECT u.id, u.username, u.display_name FROM auth_sessions s"
            " JOIN users u ON u.id = s.user_id"
            " WHERE s.id = %s AND u.is_active"
            " AND s.created_at > now() - %s::interval",
            (token, f"{SESSION_DAYS} days"),
        ).fetchone()


def delete_session(token: str | None) -> None:
    if token:
        with conn() as c:
            c.execute("DELETE FROM auth_sessions WHERE id = %s", (token,))
