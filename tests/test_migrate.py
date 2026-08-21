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
INTELLIGENCE = ("meeting_facts", "meeting_fact_participants", "meeting_user_speakers")
VERSIONS = ["001_initial", "002_productization", "003_user_identity",
            "004_meeting_intelligence", "005_meeting_held_at"]


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


def columns(schema: str, table: str) -> dict[str, tuple[str, str]]:
    return {
        r["column_name"]: (r["data_type"], r["is_nullable"])
        for r in q(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
            " WHERE table_schema = %s AND table_name = %s",
            (schema, table),
        )
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
    assert applied == VERSIONS
    assert tables(temp_schema) >= (
        set(CORE) | set(ADDED) | set(INTELLIGENCE) | {"schema_migrations"}
    )


def test_every_migration_is_recorded_once_and_rerunning_applies_nothing(temp_schema):
    migrate.run(temp_schema)
    assert migrate.run(temp_schema) == []
    rows = q(f"SELECT version, name, applied_at FROM {temp_schema}.schema_migrations"
             " ORDER BY version")
    assert [r["version"] for r in rows] == [v.split("_")[0] for v in VERSIONS]
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

    assert migrate.run(temp_schema) == VERSIONS

    kept = q(f"SELECT title, status, intelligence_state FROM {temp_schema}.meetings")
    # the row survives and the new column arrives with its default
    assert kept == [
        {"title": "기존 회의", "status": "COMPLETED", "intelligence_state": "NOT_BUILT"}
    ]
    assert tables(temp_schema) >= set(ADDED) | set(INTELLIGENCE)
    # 001 was a no-op here but is still recorded, so it never runs again
    assert len(q(f"SELECT 1 FROM {temp_schema}.schema_migrations")) == len(VERSIONS)


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


def test_a_database_already_at_003_only_gains_004(temp_schema):
    """The deployment case for this wave: the previous three are already recorded."""
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"DELETE FROM {temp_schema}.schema_migrations WHERE version = '004'")
        c.execute(f"DROP TABLE {temp_schema}.meeting_facts CASCADE")
        c.execute(f"DROP TABLE {temp_schema}.meeting_fact_participants CASCADE")
        c.execute(f"DROP TABLE {temp_schema}.meeting_user_speakers CASCADE")
        c.commit()

    assert migrate.run(temp_schema) == ["004_meeting_intelligence"]
    assert tables(temp_schema) >= set(INTELLIGENCE)
    assert migrate.run(temp_schema) == []


def test_a_database_already_at_004_only_gains_005(temp_schema):
    """The deployment case for this wave. 005 only widens: held_at is a new
    nullable column and the status CHECK accepts everything it accepted before,
    so a database holding real facts crosses it without losing a row."""
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status)"
            " VALUES ('기존 회의','a.wav','a.wav','COMPLETED') RETURNING id"
        ).fetchone()["id"]
        seg = c.execute(
            "INSERT INTO transcript_segments (meeting_id, sequence, start_time, end_time,"
            " text) VALUES (%s,0,0,1,'기존 발화') RETURNING id", (mid,)
        ).fetchone()["id"]
        c.execute(
            "INSERT INTO meeting_facts (meeting_id, fact_type, content, status, start_time,"
            " end_time, source_segment_ids, source_text)"
            " VALUES (%s,'REQUEST','기존 요청','OPEN',0,1,%s,'기존 발화')",
            (mid, [seg]),
        )
        c.execute(f"ALTER TABLE {temp_schema}.meetings DROP COLUMN held_at")
        c.execute(f"DELETE FROM {temp_schema}.schema_migrations WHERE version = '005'")
        c.commit()

    assert migrate.run(temp_schema) == ["005_meeting_held_at"]
    assert columns(temp_schema, "meetings")["held_at"] == ("timestamp with time zone", "YES")
    rows = q(f"SELECT content, status FROM {temp_schema}.meeting_facts")
    assert rows == [{"content": "기존 요청", "status": "OPEN"}]
    assert migrate.run(temp_schema) == []


def test_an_unproven_fact_status_is_storable_and_is_the_default(temp_schema):
    """UNKNOWN has to be a real value, not a convention the application keeps."""
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status)"
            " VALUES ('회의','a.wav','a.wav','COMPLETED') RETURNING id"
        ).fetchone()["id"]
        seg = c.execute(
            "INSERT INTO transcript_segments (meeting_id, sequence, start_time, end_time,"
            " text) VALUES (%s,0,0,1,'발화') RETURNING id", (mid,)
        ).fetchone()["id"]
        row = c.execute(
            "INSERT INTO meeting_facts (meeting_id, fact_type, content, start_time,"
            " end_time, source_segment_ids, source_text)"
            " VALUES (%s,'REQUEST','요청',0,1,%s,'발화') RETURNING status",
            (mid, [seg]),
        ).fetchone()
        assert row["status"] == "UNKNOWN"
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute(
                "INSERT INTO meeting_facts (meeting_id, fact_type, content, status,"
                " start_time, end_time, source_segment_ids, source_text)"
                " VALUES (%s,'REQUEST','요청','아마도',0,1,%s,'발화')",
                (mid, [seg]),
            )


def test_a_speaker_cannot_be_claimed_across_meetings(temp_schema):
    """The composite foreign key, not application code, is what refuses this."""
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        mine, theirs = (
            c.execute(
                "INSERT INTO meetings (title, original_filename, stored_filename)"
                " VALUES (%s,'a.wav','a.wav') RETURNING id", (title,)
            ).fetchone()[0]
            for title in ("내 회의", "다른 회의")
        )
        speaker = c.execute(
            "INSERT INTO speakers (meeting_id, speaker_code) VALUES (%s,'SPEAKER_00')"
            " RETURNING id", (theirs,)
        ).fetchone()[0]
        user = c.execute(
            "INSERT INTO users (username, password_hash) VALUES ('t','x') RETURNING id"
        ).fetchone()[0]
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            c.execute(
                "INSERT INTO meeting_user_speakers (meeting_id, user_id, speaker_id)"
                " VALUES (%s,%s,%s)", (mine, user, speaker)
            )


def test_a_fact_without_a_source_segment_is_refused_by_the_database(temp_schema):
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename)"
            " VALUES ('회의','a.wav','a.wav') RETURNING id"
        ).fetchone()[0]
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute(
                "INSERT INTO meeting_facts (meeting_id, fact_type, content, start_time,"
                " end_time, source_segment_ids, source_text)"
                " VALUES (%s,'REQUEST','근거 없는 요청',0,1,'{}','')", (mid,)
            )
