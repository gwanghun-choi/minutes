"""How the built React app and the API share one origin.

The frontend is no longer a template this process renders, so what is worth
pinning here changed: not the DOM, but the routing contract between FastAPI and
React Router, and the promise that nothing secret ends up in a browser bundle.
Component behaviour is tested in `frontend/src/test` and `frontend/e2e`.
"""
import pytest

from app import config, main
from conftest import requires_db

pytestmark = requires_db

WEB_DIR = config.BASE_DIR / "frontend" / "dist"
HAS_BUILD = (WEB_DIR / "index.html").is_file()
needs_build = pytest.mark.skipif(
    not HAS_BUILD, reason="frontend/dist is missing - run `npm run build` in frontend/"
)


def test_an_unknown_api_route_is_a_404_not_the_page(client):
    """The SPA fallback must never answer for /api/. A caller would otherwise
    have to parse HTML to discover its request was wrong."""
    res = client.get("/api/does-not-exist")
    assert res.status_code == 404
    assert "<!doctype html" not in res.text.lower()


def test_health_is_still_json_and_still_public(anon):
    res = anon.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


@needs_build
@pytest.mark.parametrize("path", ["/", "/login", "/meetings/12", "/chat/3", "/anything"])
def test_every_client_route_and_refresh_gets_the_app_shell(client, path):
    """Deep links and refreshes are React Router's job, so they all resolve to
    index.html rather than a server 404."""
    res = client.get(path)
    assert res.status_code == 200, path
    assert "<div id=\"root\">" in res.text


@needs_build
def test_the_shell_carries_no_user_data(anon, client):
    """It is the same bytes for everyone: identity comes from /api/auth/me, so
    an anonymous shell leaks nothing and can be cached like any other asset."""
    signed_out = anon.get("/")
    signed_in = client.get("/")
    assert signed_out.status_code == 200
    assert signed_out.text == signed_in.text
    assert client.account["username"] not in signed_in.text
    assert client.account["display_name"] not in signed_in.text


@needs_build
def test_the_hashed_assets_are_served(client):
    asset = next((WEB_DIR / "assets").glob("*.js"))
    res = client.get(f"/assets/{asset.name}")
    assert res.status_code == 200
    assert len(res.content) == asset.stat().st_size


@needs_build
@pytest.mark.parametrize("path", ["/../requirements.txt", "/assets/../../requirements.txt"])
def test_a_traversal_attempt_cannot_reach_outside_the_build(client, path):
    """`..` in a URL resolves to index.html, never to a file in the repository."""
    res = client.get(path)
    assert "fastapi==" not in res.text


@needs_build
def test_no_secret_reaches_the_browser_bundle():
    """Anything in the bundle is public. Server-side settings must never be
    compiled into it, whatever a Vite env variable might tempt someone to add."""
    bundle = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore") for p in WEB_DIR.rglob("*.js")
    )
    for name in ("OPENAI_API_KEY", "HF_TOKEN", "DATABASE_PASSWORD", "MINUTES_BOOTSTRAP_PASSWORD"):
        assert name not in bundle
    for secret in (config.OPENAI_API_KEY, config.HF_TOKEN, config.DB_PASSWORD):
        if secret:
            assert secret not in bundle


def test_the_api_is_closed_by_default_and_login_is_the_only_exception():
    """The middleware lists what is open rather than decorating what is closed,
    so a new endpoint is protected the moment it is written."""
    assert main.PUBLIC_API == {"/api/auth/login"}
