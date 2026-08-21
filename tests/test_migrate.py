"""The migration runner.

Schema changes are a deployment step, not something the application does on the
way up. These tests run migrations for real, but never against the configured
schema — that one holds actual meeting data. Each test gets a throwaway
`minutes_test_*` schema, created and dropped here, so a fresh database and an
existing one can both be exercised honestly.
"""
import secrets

import psycopg
import pytest
from conftest import requires_db
from psycopg.rows import dict_row

from app import db
from scripts import migrate

pytestmark = requires_db

CORE = ("meetings", "speakers", "transcript_segments", "chunks")
ADDED = ("users", "auth_sessions", "chat_sessions", "chat_messages", "meeting_summaries")


def q(sql: str, params=None) -> list[dict]:
    """A standalone query. Never the pool, whose search_path is the real schema."""
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        return c.execute(sql, params).fetchall()


def tables(schema: str) -> set[str]:
    return {
        r["table_name"]
        for r in q("SELECT table_name FROM information_schema.tables WHERE table_schema = %s",
                   (schema,))
    }


@pytest.fixture
def temp_schema():
    name = f"minutes_test_{secrets.token_hex(4)}"
    yield name
    assert name.startswith("minutes_test_")  # never drop anything else
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")


def test_fresh_database_gets_the_whole_current_schema(temp_schema):
    applied = migrate.run(temp_schema)
    assert applied == ["001_initial", "002_productization", "003_user_identity"]
    assert tables(temp_schema) >= set(CORE) | set(ADDED) | {"schema_migrations"}


def test_every_migration_is_recorded_once_and_rerunning_applies_nothing(temp_schema):
    migrate.run(temp_schema)
    assert migrate.run(temp_schema) == []
    rows = q(f"SELECT version, name, applied_at FROM {temp_schema}.schema_migrations"
             " ORDER BY version")
    assert [r["version"] for r in rows] == ["001", "002", "003"]
    assert all(r["applied_at"] for r in rows)


def test_an_existing_database_keeps_its_data_and_gains_the_new_tables(temp_schema):
    """The NCP case: core tables and real meetings already exist, nothing else does."""
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"CREATE SCHEMA {temp_schema}")
        c.execute(f"SET search_path TO {temp_schema}, public")
        c.execute((migrate.MIGRATIONS / "001_initial.sql").read_text(encoding="utf-8")
                  .replace("{{SCHEMA}}", temp_schema))
        c.execute(
            f"INSERT INTO {temp_schema}.meetings (title, original_filename, stored_filename,"
            " status) VALUES ('기존 회의', 'a.wav', 'a.wav', 'COMPLETED')"
        )
        c.commit()
    assert not (tables(temp_schema) & set(ADDED))

    assert migrate.run(temp_schema) == ["001_initial", "002_productization", "003_user_identity"]

    kept = q(f"SELECT title, status FROM {temp_schema}.meetings")
    assert kept == [{"title": "기존 회의", "status": "COMPLETED"}]
    assert tables(temp_schema) >= set(ADDED)
    # 001 was a no-op here but is still recorded, so it never runs again
    assert len(q(f"SELECT 1 FROM {temp_schema}.schema_migrations")) == 3


def test_users_carries_the_identity_metadata(temp_schema):
    migrate.run(temp_schema)
    cols = {
        r["column_name"]: r
        for r in q(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
            " WHERE table_schema = %s AND table_name = 'users'",
            (temp_schema,),
        )
    }
    assert set(cols) == {
        "id", "username", "password_hash",
        "display_name", "is_active", "created_at", "updated_at", "last_login_at",
    }
    assert cols["id"]["data_type"] == "bigint"  # internal key, not the login id
    assert cols["last_login_at"]["is_nullable"] == "YES"  # nobody has logged in yet


def test_the_default_account_is_seeded_hashed_and_only_once(temp_schema):
    from app.services import auth

    migrate.run(temp_schema)
    rows = q(f"SELECT * FROM {temp_schema}.users")
    assert len(rows) == 1
    user = rows[0]
    assert (user["username"], user["display_name"], user["is_active"]) == ("user", "사용자", True)
    assert "user1234" not in user["password_hash"]
    assert auth.verify_password("user1234", user["password_hash"])

    migrate.run(temp_schema)
    again = q(f"SELECT * FROM {temp_schema}.users")
    assert len(again) == 1
    assert again[0]["password_hash"] == user["password_hash"]


def test_a_rerun_never_resets_a_password_that_has_since_changed(temp_schema):
    """The version record is the first defence; the seed's WHERE NOT EXISTS is the second."""
    from app.services import auth

    migrate.run(temp_schema)
    changed = auth.hash_password("something the operator chose")
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"UPDATE {temp_schema}.users SET password_hash = %s WHERE username = 'user'",
                  (changed,))
    with psycopg.connect(db.conninfo()) as c:  # force the seed to run again
        c.execute(f"DELETE FROM {temp_schema}.schema_migrations WHERE version = '003'")

    migrate.run(temp_schema)
    assert q(f"SELECT password_hash FROM {temp_schema}.users")[0]["password_hash"] == changed


def test_a_failing_migration_records_nothing_and_leaves_no_half_state(temp_schema, tmp_path,
                                                                     monkeypatch):
    good = tmp_path / "001_good.sql"
    good.write_text("CREATE TABLE {{SCHEMA}}.good (id INT);", encoding="utf-8")
    bad = tmp_path / "002_bad.sql"
    bad.write_text(
        "CREATE TABLE {{SCHEMA}}.half (id INT);\nSELECT nonexistent_function();",
        encoding="utf-8",
    )
    monkeypatch.setattr(migrate, "MIGRATIONS", tmp_path)

    with pytest.raises(psycopg.Error):
        migrate.run(temp_schema)

    versions = [r["version"] for r in q(f"SELECT version FROM {temp_schema}.schema_migrations")]
    assert versions == ["001"]  # the good one stands, the failed one is not recorded
    assert "half" not in tables(temp_schema)  # its first statement rolled back too
    assert "good" in tables(temp_schema)


def test_startup_refuses_an_unmigrated_database(temp_schema):
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"CREATE SCHEMA {temp_schema}")

    with pytest.raises(RuntimeError, match="DB migration이 필요합니다"):
        migrate.verify(1024, temp_schema)

    migrate.run(temp_schema)
    migrate.verify(1024, temp_schema)  # now it is satisfied


def test_startup_refuses_a_vector_width_the_column_cannot_hold(temp_schema):
    migrate.run(temp_schema)
    with pytest.raises(RuntimeError, match="vector"):
        migrate.verify(768, temp_schema)


def test_the_application_owns_no_ddl():
    """The invariant itself: nothing in the startup path can create or alter a table."""
    import inspect

    from app import main

    assert not hasattr(db, "apply_schema")
    source = inspect.getsource(main.lifespan) + inspect.getsource(db)
    for statement in ("CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "CREATE EXTENSION"):
        assert statement not in source.upper()
