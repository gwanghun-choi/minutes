"""The POC identity boundary.

What matters here is that the server refuses anonymous requests. A hidden button
is not a boundary; a 401 is.
"""
from conftest import requires_db

from app.services import auth

pytestmark = requires_db


def test_health_and_login_stay_public(anon):
    assert anon.get("/health").status_code == 200
    assert anon.post("/api/auth/login", json={"username": "x", "password": "y"}).status_code == 401


def test_anonymous_pages_are_the_untouched_build(anon):
    """The app shell is public and carries no data; the boundary is the API.

    It used to be a 303 to /login because the server rendered the page. React
    Router decides that now, off the back of a 401 from /api/auth/me — so what
    has to hold is that an anonymous page is the build file verbatim, with
    nothing about anybody in it.
    """
    from app.main import INDEX

    shell = INDEX.read_text(encoding="utf-8") if INDEX.is_file() else None
    for path in ("/", "/chat", "/meetings/1"):
        res = anon.get(path)
        if shell is None:
            assert res.status_code == 503, path  # no build in this checkout
        else:
            assert res.status_code == 200, path
            assert res.text == shell, path
    assert anon.get("/api/auth/me").status_code == 401


def test_anonymous_api_is_rejected_not_hidden(anon):
    """Every JSON route, including the ones the UI would never show."""
    assert anon.get("/api/meetings").status_code == 401
    assert anon.post("/api/chat/sessions", json={}).status_code == 401
    assert anon.get("/api/chat/sessions").status_code == 401
    assert anon.delete("/api/meetings/1").status_code == 401
    assert anon.post("/api/meetings/1/approve").status_code == 401


def test_login_opens_the_api(client):
    assert client.get("/api/meetings").status_code == 200


def test_wrong_password_is_refused(anon, accounts):
    account = accounts()
    res = anon.post(
        "/api/auth/login", json={"username": account["username"], "password": "wrong"}
    )
    assert res.status_code == 401
    assert anon.get("/api/meetings").status_code == 401


def test_unknown_user_is_refused_with_the_same_message(anon, accounts):
    account = accounts()
    unknown = anon.post("/api/auth/login", json={"username": "nobody_here", "password": "x"})
    wrong = anon.post(
        "/api/auth/login", json={"username": account["username"], "password": "x"}
    )
    assert unknown.status_code == wrong.status_code == 401
    # identical text, so the response never reveals which usernames exist
    assert unknown.json()["detail"] == wrong.json()["detail"]


def test_logout_invalidates_the_session_server_side(client):
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/meetings").status_code == 401


def test_password_is_never_stored_in_plaintext(client):
    from app.db import conn

    with conn() as c:
        stored = c.execute(
            "SELECT password_hash FROM users WHERE id = %s", (client.account["id"],)
        ).fetchone()["password_hash"]
    assert client.account["password"] not in stored
    assert stored.startswith("scrypt$")
    assert auth.verify_password(client.account["password"], stored)
    assert not auth.verify_password("something else", stored)


def test_a_forged_cookie_resolves_to_nobody(anon, client):
    """The cookie is an opaque key, so editing it cannot mint a session."""
    real = client.cookies[auth.COOKIE_NAME]
    for forged in (real[:-1] + ("a" if real[-1] != "a" else "b"), "", "1", real + "x"):
        anon.cookies.set(auth.COOKIE_NAME, forged)
        assert anon.get("/api/meetings").status_code == 401


def _deactivate(user_id: int) -> None:
    from app.db import conn

    with conn() as c:
        c.execute("UPDATE users SET is_active = false WHERE id = %s", (user_id,))


def test_inactive_user_cannot_log_in(anon, accounts):
    account = accounts()
    _deactivate(account["id"])
    res = anon.post(
        "/api/auth/login",
        json={"username": account["username"], "password": account["password"]},
    )
    assert res.status_code == 401


def test_deactivating_a_user_closes_the_session_it_already_has(client):
    """A live cookie is not a second source of truth - the user row still decides."""
    assert client.get("/api/meetings").status_code == 200
    _deactivate(client.account["id"])
    assert client.get("/api/meetings").status_code == 401
    assert client.get("/api/chat/sessions").status_code == 401


def _last_login(user_id: int):
    from app.db import conn

    with conn() as c:
        return c.execute(
            "SELECT last_login_at FROM users WHERE id = %s", (user_id,)
        ).fetchone()["last_login_at"]


def test_successful_login_records_last_login_at(anon, accounts):
    account = accounts()
    assert _last_login(account["id"]) is None
    res = anon.post(
        "/api/auth/login",
        json={"username": account["username"], "password": account["password"]},
    )
    assert res.status_code == 200
    assert _last_login(account["id"]) is not None


def test_failed_login_leaves_last_login_at_alone(anon, accounts):
    account = accounts()
    anon.post("/api/auth/login", json={"username": account["username"], "password": "wrong"})
    assert _last_login(account["id"]) is None


def test_the_seeded_poc_account_can_log_in(anon):
    """`user` / `user1234` comes from migration 003, not from any startup code."""
    from app.db import conn

    res = anon.post("/api/auth/login", json={"username": "user", "password": "user1234"})
    assert res.status_code == 200
    try:
        assert res.json()["display_name"] == "사용자"
        assert anon.get("/api/meetings").status_code == 200
    finally:
        anon.post("/api/auth/logout")
    with conn() as c:
        stored = c.execute(
            "SELECT password_hash FROM users WHERE username = 'user'"
        ).fetchone()["password_hash"]
    assert "user1234" not in stored


def test_the_current_user_comes_from_the_api(client):
    """The page is the same bytes for everyone, so this is the only place the
    frontend can learn who is signed in."""
    res = client.get("/api/auth/me")
    assert res.status_code == 200
    body = res.json()
    assert body["username"] == client.account["username"]  # the login id
    assert body["display_name"] == client.account["display_name"]  # the label people read
    assert body["id"] == client.account["id"]
    assert "password" not in body and "password_hash" not in body


def test_who_am_i_is_closed_to_anonymous_callers(anon):
    assert anon.get("/api/auth/me").status_code == 401
