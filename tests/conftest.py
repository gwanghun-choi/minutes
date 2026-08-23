"""Shared fixtures.

Every route except `/health`, `/login`, and the login API now requires a session,
so the client fixture logs in. Accounts are throwaway: deleting the user cascades
to its auth sessions and its whole chat history, so a test run leaves nothing
behind. Nothing here touches meetings created outside the test suite.
"""
import math
import re
import secrets
import zlib

import pytest
from fastapi.testclient import TestClient


def db_available() -> bool:
    try:
        from app.db import conn, init_pool

        init_pool()
        with conn() as c:
            c.execute("SELECT 1")
        return True
    except Exception:
        return False


DB_OK = db_available()
if DB_OK:
    # The application never applies DDL - schema is a deployment step. Tests run
    # the same migration runner explicitly, which is also what keeps a developer
    # database current without a separate command.
    from scripts import migrate

    migrate.run()

requires_db = pytest.mark.skipif(not DB_OK, reason="minutes database is not reachable")


def _dim() -> int:
    """The live vector width, read from the column so no model has to load."""
    from app import config
    from app.db import conn

    with conn() as c:
        row = c.execute(
            "SELECT a.atttypmod AS dim FROM pg_attribute a"
            " JOIN pg_class t ON t.oid = a.attrelid"
            " JOIN pg_namespace n ON n.oid = t.relnamespace"
            " WHERE n.nspname = %s AND t.relname = 'chunks' AND a.attname = 'embedding'",
            (config.DB_SCHEMA,),
        ).fetchone()
    return row["dim"] if row else 0


DB_OK = DB_OK and _dim() > 0


@pytest.fixture
def column_dim() -> int:
    return _dim()


def fake_vector(text: str, dim: int) -> list[float]:
    """A deterministic stand-in for BGE-M3. Never loads a model.

    Content-sensitive on purpose: a constant vector would make every cosine
    distance a tie, and a scope or ranking test would then pass by accident.
    Each distinct word owns one dimension, so a chunk sharing a word with the
    query really is nearer than one that does not.
    """
    v = [0.0] * dim
    v[0] = 0.1  # never the zero vector, which has no direction to compare
    for word in set(re.findall(r"[\w가-힣]+", text)):
        v[1 + zlib.crc32(word.encode()) % (dim - 1)] = 1.0
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]


@pytest.fixture(autouse=True)
def fake_embeddings(monkeypatch):
    if not DB_OK:
        return  # the pure-logic tests need neither the database nor this patch
    from app.services import embedding

    dim = _dim()
    monkeypatch.setattr(embedding, "encode", lambda texts: [fake_vector(t, dim) for t in texts])
    monkeypatch.setattr(embedding, "encode_one", lambda text: fake_vector(text, dim))


@pytest.fixture
def accounts():
    """Factory for throwaway users. All of them are removed at teardown."""
    from app.db import conn
    from app.services import auth

    ids: list[int] = []

    def make(display_name: str | None = None) -> dict:
        username = f"pytest_{secrets.token_hex(6)}"
        password = secrets.token_urlsafe(12)
        display_name = display_name or f"테스터 {username[-4:]}"
        with conn() as c:
            row = c.execute(
                "INSERT INTO users (username, password_hash, display_name)"
                " VALUES (%s,%s,%s) RETURNING id",
                (username, auth.hash_password(password), display_name),
            ).fetchone()
        ids.append(row["id"])
        return {
            "id": row["id"], "username": username,
            "password": password, "display_name": display_name,
        }

    yield make

    with conn() as c:
        c.execute("DELETE FROM users WHERE id = ANY(%s)", (ids,))


@pytest.fixture
def login(accounts):
    """Factory: a TestClient already holding a session cookie for a fresh user."""
    from app.main import app

    def _login() -> TestClient:
        account = accounts()
        # TestClient without the lifespan: the pool and schema already exist.
        c = TestClient(app)
        res = c.post(
            "/api/auth/login",
            json={"username": account["username"], "password": account["password"]},
        )
        assert res.status_code == 200, res.text
        c.account = account
        return c

    return _login


@pytest.fixture
def client(login) -> TestClient:
    return login()


@pytest.fixture
def anon() -> TestClient:
    from app.main import app

    return TestClient(app, follow_redirects=False)


# Sentinel for "whoever the `client` fixture is logged in as". `None` is a
# meaningful owner value now — an orphan — so the default cannot be None.
MINE = object()


@pytest.fixture
def make_meeting(client):
    """Factory for meetings with a real transcript. Removed at teardown.

    `days_ago` fixes `created_at` — when the recording was uploaded. `held_ago`
    fixes `held_at`, when the meeting actually happened, and is what chronology
    and relative deadlines read. Leaving it None makes a legacy meeting: no
    held_at at all, which is exactly what most stored meetings look like.

    `owner` is the account id the meeting belongs to, and it defaults to the
    account `client` is logged in as — the same thing an upload through the API
    would produce, so a test that just wants "my meeting" gets one. Pass another
    account's id to make somebody else's, or `None` for an *orphan*: a meeting
    from before migration 009 whose uploader could not be proven, which
    `access.READABLE` makes readable by nobody.
    """
    from app.db import conn
    from app.services import pipeline, versions

    ids: list[int] = []

    def make(title, lines, status="COMPLETED", days_ago=0, held_ago=None, owner=MINE):
        if owner is MINE:
            owner = client.account["id"]
        with conn() as c:
            mid = c.execute(
                "INSERT INTO meetings (title, original_filename, stored_filename, status,"
                " created_at, held_at, owner_user_id)"
                " VALUES (%s,'x.wav','x.wav','REVIEW_REQUIRED',"
                " now() - make_interval(days => %s),"
                " CASE WHEN %s::int IS NULL THEN NULL"
                "      ELSE now() - make_interval(days => %s::int) END, %s) RETURNING id",
                (title, days_ago, held_ago, held_ago, owner),
            ).fetchone()["id"]
            versions.start(mid, owner, c)
        pipeline._persist_transcript(
            mid,
            [
                {"start": i * 5.0, "end": i * 5.0 + 4.0, "text": text, "speaker": speaker}
                for i, (speaker, text) in enumerate(lines)
            ],
        )
        if status == "COMPLETED":
            pipeline.set_status(mid, "INDEXING")
            pipeline.index_transcript(mid, 1)
        else:
            pipeline.set_status(mid, status)
        ids.append(mid)
        return mid

    yield make

    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = ANY(%s)", (ids,))


@pytest.fixture
def legacy_revision():
    """A second revision, written the way the build that had 회의록 수정 wrote one.

    The product no longer creates these — approved minutes are immutable — but a
    deployed database may already hold one, and migrations here only add. Written
    straight to the tables for exactly that reason: there is no API left that
    could produce this state, and the tests that use it are about reading it
    safely rather than about how it got there.
    """
    from app.db import conn

    def make(meeting_id: int, texts: list[str], version: int = 2, status="PUBLISHED"):
        with conn() as c:
            speaker = c.execute(
                "SELECT id FROM speakers WHERE meeting_id = %s ORDER BY speaker_code LIMIT 1",
                (meeting_id,),
            ).fetchone()
            if status == "PUBLISHED":
                c.execute(
                    "UPDATE meeting_versions SET status = 'SUPERSEDED'"
                    " WHERE meeting_id = %s AND status = 'PUBLISHED'",
                    (meeting_id,),
                )
            c.execute(
                "INSERT INTO meeting_versions (meeting_id, version, status, published_at)"
                " VALUES (%s,%s,%s, CASE WHEN %s = 'PUBLISHED' THEN now() END)",
                (meeting_id, version, status, status),
            )
            for i, text in enumerate(texts):
                c.execute(
                    "INSERT INTO transcript_segments"
                    " (meeting_id, speaker_id, version, sequence, start_time, end_time, text)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (meeting_id, speaker["id"] if speaker else None, version,
                     i, i * 5.0, i * 5.0 + 4.0, text),
                )
        return version

    return make


@pytest.fixture
def share():
    """Give an account accepted read access to a meeting, the way an owner would.

    Written straight to `meeting_shares` on purpose: this is a *precondition* for
    tests about something else. The invite -> accept -> revoke flow through the
    API is what `tests/test_sharing.py` covers, and a fixture that went through
    it would make every other test depend on that flow still working.
    """
    from app.db import conn

    def grant(meeting_id: int, user_id: int, by: int | None = None, status="ACCEPTED"):
        with conn() as c:
            owner = by or c.execute(
                "SELECT owner_user_id FROM meetings WHERE id = %s", (meeting_id,)
            ).fetchone()["owner_user_id"]
            return c.execute(
                "INSERT INTO meeting_shares (meeting_id, invited_user_id, invited_by_user_id,"
                " status, responded_at) VALUES (%s,%s,%s,%s, now())"
                " ON CONFLICT (meeting_id, invited_user_id)"
                "   DO UPDATE SET status = EXCLUDED.status, responded_at = now()"
                " RETURNING id",
                (meeting_id, user_id, owner, status),
            ).fetchone()["id"]

    return grant


@pytest.fixture(autouse=True)
def fake_extract(monkeypatch):
    """Stand in for fact extraction: reply with whatever the test sets, and
    record everything the model was shown.

    Autouse for the same reason `fake_embeddings` is: approving a meeting queues
    an extraction, and no test may reach the real OpenAI API. A test that wants
    to control the reply just asks for this fixture by name.
    """
    from app.services import intelligence

    state = {"prompts": [], "replies": [], "reply": '{"facts": []}'}

    def _complete(system, user):
        state["prompts"].append(user)
        return state["replies"].pop(0) if state["replies"] else state["reply"]

    monkeypatch.setattr(intelligence, "_complete", _complete)
    return state
