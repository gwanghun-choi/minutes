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


@pytest.fixture
def make_meeting():
    """Factory for meetings with a real transcript. Removed at teardown.

    `days_ago` fixes `created_at` — when the recording was uploaded. `held_ago`
    fixes `held_at`, when the meeting actually happened, and is what chronology
    and relative deadlines read. Leaving it None makes a legacy meeting: no
    held_at at all, which is exactly what most stored meetings look like.
    """
    from app.db import conn
    from app.services import pipeline

    ids: list[int] = []

    def make(title, lines, status="COMPLETED", days_ago=0, held_ago=None):
        with conn() as c:
            mid = c.execute(
                "INSERT INTO meetings (title, original_filename, stored_filename, status,"
                " created_at, held_at) VALUES (%s,'x.wav','x.wav','REVIEW_REQUIRED',"
                " now() - make_interval(days => %s),"
                " CASE WHEN %s::int IS NULL THEN NULL"
                "      ELSE now() - make_interval(days => %s::int) END) RETURNING id",
                (title, days_ago, held_ago, held_ago),
            ).fetchone()["id"]
        pipeline._persist_transcript(
            mid,
            [
                {"start": i * 5.0, "end": i * 5.0 + 4.0, "text": text, "speaker": speaker}
                for i, (speaker, text) in enumerate(lines)
            ],
        )
        if status == "COMPLETED":
            pipeline.set_status(mid, "INDEXING")
            pipeline.index_transcript(mid)
        else:
            pipeline.set_status(mid, status)
        ids.append(mid)
        return mid

    yield make

    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = ANY(%s)", (ids,))


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
