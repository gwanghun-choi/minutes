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
# How one account arranged its own screen (011). Not properties of a meeting.
PERSONAL = ("user_categories", "user_meeting_filing")
VERSIONS = ["001_initial", "002_productization", "003_user_identity",
            "004_meeting_intelligence", "005_meeting_held_at",
            "006_meeting_categories", "007_lexical_retrieval",
            "008_category_hierarchy", "009_meeting_ownership_sharing_versions",
            "010_uat_second_account", "011_personal_organization"]


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
    assert tables(temp_schema) >= set(ADDED) | set(INTELLIGENCE) | set(PERSONAL)
    # 001 was a no-op here but is still recorded, so it never runs again
    assert len(q(f"SELECT 1 FROM {temp_schema}.schema_migrations")) == len(VERSIONS)


def test_categories_gain_a_parent_that_existing_rows_leave_null(temp_schema):
    """008 on a database that already holds flat categories.

    Every existing category has to survive as a root: the column is added, no row
    moves, and no name changes.
    """
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"CREATE SCHEMA {temp_schema}")
        c.execute(f"SET search_path TO {temp_schema}, public")
        for version in ("001_initial", "006_meeting_categories"):
            c.execute((migrate.MIGRATIONS / f"{version}.sql").read_text(encoding="utf-8")
                      .replace("{{SCHEMA}}", temp_schema))
        c.execute(f"INSERT INTO {temp_schema}.meeting_categories (name) VALUES ('업무'), ('개인')")
        c.commit()
    assert "parent_id" not in columns(temp_schema, "meeting_categories")

    migrate.run(temp_schema)

    cols = columns(temp_schema, "meeting_categories")
    assert cols["parent_id"] == ("bigint", "YES")
    rows = q(f"SELECT name, parent_id FROM {temp_schema}.meeting_categories ORDER BY name")
    assert [(r["name"], r["parent_id"]) for r in rows] == [("개인", None), ("업무", None)]


def test_a_category_cannot_be_its_own_parent_at_the_database_level(temp_schema):
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        row = c.execute(
            f"INSERT INTO {temp_schema}.meeting_categories (name) VALUES ('업무') RETURNING id"
        ).fetchone()
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute(
                f"UPDATE {temp_schema}.meeting_categories SET parent_id = %s WHERE id = %s",
                (row[0], row[0]),
            )


# The two SQLSTATEs PostgreSQL uses for a refused ON DELETE RESTRICT.
#
# 23503 foreign_key_violation up to PostgreSQL 17, 23001 restrict_violation from
# 18. Both are IntegrityError and neither subclasses the other, so naming one
# exception class pinned the test to a server version rather than to the rule.
RESTRICT_SQLSTATES = {"23503", "23001"}


def test_deleting_a_parent_is_restricted_by_the_foreign_key(temp_schema):
    """ON DELETE RESTRICT, never CASCADE: a parent cannot take its children.

    Asserted as the invariant rather than as an exception class: the statement is
    refused with one of the two codes PostgreSQL uses for exactly this, and both
    rows are still there afterwards. The second half is the part that matters —
    a refusal that still deleted something would pass a `pytest.raises` alone.
    """
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        parent = c.execute(
            f"INSERT INTO {temp_schema}.meeting_categories (name) VALUES ('업무') RETURNING id"
        ).fetchone()[0]
        c.execute(
            f"INSERT INTO {temp_schema}.meeting_categories (name, parent_id)"
            " VALUES ('개발', %s)",
            (parent,),
        )
        # Committed first, so the rollback below undoes the failed DELETE and not
        # the rows this test is checking survived it.
        c.commit()
        with pytest.raises(psycopg.IntegrityError) as refused:
            c.execute(f"DELETE FROM {temp_schema}.meeting_categories WHERE id = %s", (parent,))
        assert refused.value.sqlstate in RESTRICT_SQLSTATES
        c.rollback()

    assert {r["name"] for r in q(f"SELECT name FROM {temp_schema}.meeting_categories")} == {
        "업무", "개발",
    }


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


# The accounts the migrations seed, and the password each is seeded with. 010
# added the second one so ownership and sharing can be exercised by two people;
# both are seeded the same way, by the same kind of statement, and neither
# plaintext is ever stored.
SEEDED = {"user": "user1234", "user2": "user1234"}


def test_the_default_accounts_are_seeded_hashed_and_only_once(temp_schema):
    from app.services import auth

    migrate.run(temp_schema)
    rows = {r["username"]: r for r in q(f"SELECT * FROM {temp_schema}.users")}
    assert set(rows) == set(SEEDED)
    for username, password in SEEDED.items():
        user = rows[username]
        assert user["is_active"] is True
        # The plaintext never reaches the database — only a scrypt hash the
        # application's own verifier accepts.
        assert password not in user["password_hash"]
        assert auth.verify_password(password, user["password_hash"])
        assert not auth.verify_password(password + "x", user["password_hash"])

    # Re-running changes nothing: no duplicate row, no rotated password.
    migrate.run(temp_schema)
    again = {r["username"]: r for r in q(f"SELECT * FROM {temp_schema}.users")}
    assert set(again) == set(SEEDED)
    for username in SEEDED:
        assert again[username]["password_hash"] == rows[username]["password_hash"]


@pytest.mark.parametrize("username, version", [("user", "003"), ("user2", "010")])
def test_a_rerun_never_resets_a_password_that_has_since_changed(temp_schema, username, version):
    """The version record is the first defence; the seed's WHERE NOT EXISTS is the second."""
    from app.services import auth

    migrate.run(temp_schema)
    changed = auth.hash_password("something the operator chose")
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"UPDATE {temp_schema}.users SET password_hash = %s WHERE username = %s",
                  (changed, username))
    with psycopg.connect(db.conninfo()) as c:  # force the seed to run again
        c.execute(f"DELETE FROM {temp_schema}.schema_migrations WHERE version = %s", (version,))

    migrate.run(temp_schema)
    assert q(f"SELECT password_hash FROM {temp_schema}.users WHERE username = %s",
             (username,))[0]["password_hash"] == changed


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


def test_a_database_already_at_005_only_gains_006(temp_schema):
    """The deployment case for this wave: 006 only adds a table, a nullable
    column, and an index, so an existing meeting crosses it untouched."""
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status)"
            " VALUES ('기존 회의','a.wav','a.wav','COMPLETED')"
        )
        c.execute(f"ALTER TABLE {temp_schema}.meetings DROP COLUMN category_id")
        c.execute(f"DROP TABLE {temp_schema}.meeting_categories CASCADE")
        c.execute(f"DELETE FROM {temp_schema}.schema_migrations WHERE version = '006'")
        c.commit()

    assert migrate.run(temp_schema) == ["006_meeting_categories"]
    assert columns(temp_schema, "meetings")["category_id"] == ("bigint", "YES")
    assert q(f"SELECT title, category_id FROM {temp_schema}.meetings") == [
        {"title": "기존 회의", "category_id": None}
    ]
    assert migrate.run(temp_schema) == []


def test_deleting_a_category_keeps_its_meetings_and_unfiles_them(temp_schema):
    """ON DELETE SET NULL, in the schema. A label is not a container: removing
    it must never remove a meeting, and no application code decides that."""
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        cid = c.execute(
            "INSERT INTO meeting_categories (name) VALUES ('고객 미팅') RETURNING id"
        ).fetchone()["id"]
        c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, category_id)"
            " VALUES ('분류된 회의','a.wav','a.wav',%s)", (cid,)
        )
        c.commit()

    # UNIQUE(name) is the duplicate policy, enforced by PostgreSQL.
    with psycopg.connect(db.conninfo()) as dup:
        dup.execute(f"SET search_path TO {temp_schema}, public")
        with pytest.raises(psycopg.errors.UniqueViolation):
            dup.execute("INSERT INTO meeting_categories (name) VALUES ('고객 미팅')")

    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"SET search_path TO {temp_schema}, public")
        c.execute("DELETE FROM meeting_categories WHERE id = %s", (cid,))
        c.commit()

    assert q(f"SELECT title, category_id FROM {temp_schema}.meetings") == [
        {"title": "분류된 회의", "category_id": None}
    ]


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


def test_the_lexical_index_is_generated_and_cannot_be_written_by_hand(temp_schema):
    """`lexemes` is application data; `lexeme_tsv` is derived from it by PostgreSQL.

    A tsvector the application could set independently would be free to describe
    different text than the string it came from, which is the whole failure this
    column shape prevents.
    """
    migrate.run(temp_schema)
    for table in ("chunks", "meeting_facts"):
        cols = columns(temp_schema, table)
        assert cols["lexemes"][0] == "text"
        assert cols["lexeme_tsv"][0] == "tsvector"
        generated = q(
            "SELECT is_generated, generation_expression FROM information_schema.columns"
            " WHERE table_schema = %s AND table_name = %s AND column_name = 'lexeme_tsv'",
            (temp_schema, table),
        )[0]
        assert generated["is_generated"] == "ALWAYS"
        assert "simple" in generated["generation_expression"]

    indexes = {
        r["indexname"]
        for r in q("SELECT indexname FROM pg_indexes WHERE schemaname = %s", (temp_schema,))
    }
    assert {"idx_chunks_lexeme_tsv", "idx_facts_lexeme_tsv"} <= indexes


def test_a_chunk_carries_the_segments_it_was_built_from(temp_schema):
    """Provenance for an excerpt. Nullable, because rows written before 007 have
    no ids to fill in and nothing may invent them."""
    migrate.run(temp_schema)
    cols = columns(temp_schema, "chunks")
    assert cols["source_segment_ids"] == ("ARRAY", "YES")


def test_an_existing_chunk_keeps_its_embedding_when_the_lexical_columns_arrive(
    temp_schema,
):
    """007 must be additive on a database that already holds a searchable index:
    the vectors are expensive and are not invalidated by a text column."""
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"CREATE SCHEMA {temp_schema}")
        c.execute(f"SET search_path TO {temp_schema}, public")
        for version in ("001_initial", "002_productization", "003_user_identity",
                        "004_meeting_intelligence", "005_meeting_held_at",
                        "006_meeting_categories"):
            c.execute((migrate.MIGRATIONS / f"{version}.sql").read_text(encoding="utf-8")
                      .replace("{{SCHEMA}}", temp_schema))
        mid = c.execute(
            f"INSERT INTO {temp_schema}.meetings (title, original_filename,"
            " stored_filename, status) VALUES ('기존 회의','a.wav','a.wav','COMPLETED')"
            " RETURNING id"
        ).fetchone()[0]
        c.execute(
            f"INSERT INTO {temp_schema}.chunks (meeting_id, sequence, content,"
            " start_time, end_time, embedding)"
            " VALUES (%s, 0, '화자 A: 예산은 3천만 원입니다.', 0, 4,"
            f" array_fill(0.1::real, ARRAY[1024])::vector)",
            (mid,),
        )
        c.commit()

    assert "007_lexical_retrieval" in migrate.run(temp_schema)

    row = q(f"SELECT content, lexemes, lexeme_tsv, embedding IS NOT NULL AS vec,"
            f" source_segment_ids FROM {temp_schema}.chunks")[0]
    assert row["vec"] is True                       # the expensive part survived
    assert row["content"] == "화자 A: 예산은 3천만 원입니다."
    assert row["lexemes"] is None                   # backfill is a separate step
    assert row["lexeme_tsv"] == ""                  # and the generated column follows it
    assert row["source_segment_ids"] is None        # never invented


# --------------------------------------------------- 009: ownership and versions

# Everything before ownership arrived. A database at this point is what the
# deployed one looked like, and 009 has to be additive over it.
BEFORE_OWNERSHIP = (
    "001_initial", "002_productization", "003_user_identity",
    "004_meeting_intelligence", "005_meeting_held_at", "006_meeting_categories",
    "007_lexical_retrieval", "008_category_hierarchy",
)


def _legacy(schema: str, users: list[str], status: str = "COMPLETED") -> dict:
    """A pre-009 database with one meeting, its transcript, and its index.

    -> {"meeting": id, "segment": id, "speakers": {username: user_id}}

    Built by running the earlier migrations and inserting rows the way they
    existed then — no owner column, no version column, no version row.
    """
    from app.services import auth

    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"CREATE SCHEMA {schema}")
        c.execute(f"SET search_path TO {schema}, public")
        for version in BEFORE_OWNERSHIP:
            c.execute((migrate.MIGRATIONS / f"{version}.sql").read_text(encoding="utf-8")
                      .replace("{{SCHEMA}}", schema))
        # 003 seeds 'user'; anything else the test asked for is added beside it.
        ids = {
            r["username"]: r["id"]
            for r in c.execute("SELECT id, username FROM users").fetchall()
        }
        for name in users:
            if name not in ids:
                ids[name] = c.execute(
                    "INSERT INTO users (username, password_hash, display_name)"
                    " VALUES (%s,%s,%s) RETURNING id",
                    (name, auth.hash_password("x"), name),
                ).fetchone()["id"]
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status)"
            " VALUES ('기존 회의','a.wav','a.wav',%s) RETURNING id",
            (status,),
        ).fetchone()["id"]
        spk = c.execute(
            "INSERT INTO speakers (meeting_id, speaker_code, display_name)"
            " VALUES (%s,'SPEAKER_00','화자 A') RETURNING id",
            (mid,),
        ).fetchone()["id"]
        seg = c.execute(
            "INSERT INTO transcript_segments (meeting_id, speaker_id, sequence,"
            " start_time, end_time, text) VALUES (%s,%s,0,0,4,'예산은 3천만 원입니다.')"
            " RETURNING id",
            (mid, spk),
        ).fetchone()["id"]
        c.execute(
            "INSERT INTO chunks (meeting_id, sequence, content, start_time, end_time,"
            " lexemes, embedding) VALUES (%s,0,'화자 A: 예산은 3천만 원입니다.',0,4,"
            " '예산 3000 만원', array_fill(0.1::real, ARRAY[1024])::vector)",
            (mid,),
        )
        c.commit()
    return {"meeting": mid, "segment": seg, "speaker": spk, "users": ids}


def test_009_backfills_the_owner_when_the_database_holds_one_account(temp_schema):
    """Not a guess: with one active account, nothing else could have uploaded it."""
    legacy = _legacy(temp_schema, [])

    assert "009_meeting_ownership_sharing_versions" in migrate.run(temp_schema)

    row = q(f"SELECT owner_user_id FROM {temp_schema}.meetings")[0]
    assert row["owner_user_id"] == legacy["users"]["user"]


def test_009_leaves_the_owner_null_when_the_data_cannot_prove_one(temp_schema):
    """Two accounts and no evidence. An orphan is invisible; a wrong owner would
    hand somebody else's recording to an account that never made it."""
    _legacy(temp_schema, ["second"])

    migrate.run(temp_schema)

    assert q(f"SELECT owner_user_id FROM {temp_schema}.meetings")[0]["owner_user_id"] is None


def test_009_backfills_from_the_account_that_claimed_a_speaker(temp_schema):
    """`meeting_user_speakers` is a deliberate act by a logged-in person on that
    one meeting, which makes it the strongest evidence this database holds."""
    legacy = _legacy(temp_schema, ["second"])
    with psycopg.connect(db.conninfo()) as c:
        c.execute(
            f"INSERT INTO {temp_schema}.meeting_user_speakers (meeting_id, user_id, speaker_id)"
            " VALUES (%s,%s,%s)",
            (legacy["meeting"], legacy["users"]["second"], legacy["speaker"]),
        )

    migrate.run(temp_schema)

    assert q(f"SELECT owner_user_id FROM {temp_schema}.meetings")[0]["owner_user_id"] == (
        legacy["users"]["second"]
    )


def test_009_gives_an_approved_meeting_a_published_version_one(temp_schema):
    legacy = _legacy(temp_schema, [])

    migrate.run(temp_schema)

    rows = q(f"SELECT version, status, published_at FROM {temp_schema}.meeting_versions")
    assert [(r["version"], r["status"]) for r in rows] == [(1, "PUBLISHED")]
    assert rows[0]["published_at"] is not None
    # and its existing rows are that version, with nothing rewritten
    assert q(f"SELECT version, text FROM {temp_schema}.transcript_segments")[0] == {
        "version": 1, "text": "예산은 3천만 원입니다."
    }
    assert q(f"SELECT version FROM {temp_schema}.chunks")[0]["version"] == 1
    assert legacy["meeting"]


def test_009_leaves_an_unapproved_meeting_as_a_draft(temp_schema):
    """Nothing is published, because nothing ever was."""
    _legacy(temp_schema, [], status="REVIEW_REQUIRED")

    migrate.run(temp_schema)

    rows = q(f"SELECT version, status, published_at FROM {temp_schema}.meeting_versions")
    assert [(r["version"], r["status"], r["published_at"]) for r in rows] == [(1, "DRAFT", None)]


def test_009_does_not_touch_an_existing_embedding_or_its_lexemes(temp_schema):
    """Ownership is a permission, not a reason to re-index. Re-embedding a corpus
    is the expensive thing this migration must not cause."""
    _legacy(temp_schema, [])

    migrate.run(temp_schema)

    row = q(f"SELECT content, lexemes, embedding IS NOT NULL AS vec,"
            f" lexeme_tsv FROM {temp_schema}.chunks")[0]
    assert row["vec"] is True
    assert row["content"] == "화자 A: 예산은 3천만 원입니다."
    assert row["lexemes"] == "예산 3000 만원"
    assert row["lexeme_tsv"] != ""


def test_009_and_010_are_a_no_op_on_a_second_run(temp_schema):
    legacy = _legacy(temp_schema, [])
    migrate.run(temp_schema)
    before = q(f"SELECT * FROM {temp_schema}.meeting_versions ORDER BY version")

    assert migrate.run(temp_schema) == []

    assert q(f"SELECT * FROM {temp_schema}.meeting_versions ORDER BY version") == before
    assert len(q(f"SELECT 1 FROM {temp_schema}.meetings")) == 1
    assert len(q(f"SELECT 1 FROM {temp_schema}.users")) == 2  # user + user2, once each
    assert q(f"SELECT owner_user_id FROM {temp_schema}.meetings")[0]["owner_user_id"] == (
        legacy["users"]["user"]
    )


def test_a_meeting_cannot_publish_two_versions_at_once(temp_schema):
    """The partial unique index is what makes "which version is searched" have
    exactly one answer, rather than a rule the application has to remember."""
    legacy = _legacy(temp_schema, [])
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute(
                f"INSERT INTO {temp_schema}.meeting_versions (meeting_id, version, status)"
                " VALUES (%s, 2, 'PUBLISHED')",
                (legacy["meeting"],),
            )


def test_a_meeting_cannot_have_two_open_revisions(temp_schema):
    legacy = _legacy(temp_schema, [], status="REVIEW_REQUIRED")
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute(
                f"INSERT INTO {temp_schema}.meeting_versions (meeting_id, version, status)"
                " VALUES (%s, 2, 'INDEXING')",
                (legacy["meeting"],),
            )


def test_inviting_yourself_is_refused_by_the_database(temp_schema):
    """The API never has to check it: the sharer is always the owner, so a
    self-invitation is a row the CHECK constraint will not accept."""
    legacy = _legacy(temp_schema, [])
    migrate.run(temp_schema)
    me = legacy["users"]["user"]
    with psycopg.connect(db.conninfo()) as c:
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute(
                f"INSERT INTO {temp_schema}.meeting_shares (meeting_id, invited_user_id,"
                " invited_by_user_id) VALUES (%s,%s,%s)",
                (legacy["meeting"], me, me),
            )


def test_a_meeting_can_be_offered_to_one_account_only_once(temp_schema):
    legacy = _legacy(temp_schema, ["second"])
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        args = (legacy["meeting"], legacy["users"]["second"], legacy["users"]["user"])
        c.execute(
            f"INSERT INTO {temp_schema}.meeting_shares (meeting_id, invited_user_id,"
            " invited_by_user_id) VALUES (%s,%s,%s)", args,
        )
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute(
                f"INSERT INTO {temp_schema}.meeting_shares (meeting_id, invited_user_id,"
                " invited_by_user_id) VALUES (%s,%s,%s)", args,
            )


def test_removing_an_account_orphans_its_meetings_rather_than_deleting_them(temp_schema):
    """ON DELETE SET NULL. Losing an account must never lose the recordings and
    approved minutes it owned — an orphan is recoverable, a cascade is not."""
    legacy = _legacy(temp_schema, [])
    migrate.run(temp_schema)
    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"DELETE FROM {temp_schema}.users WHERE id = %s", (legacy["users"]["user"],))

    rows = q(f"SELECT title, owner_user_id FROM {temp_schema}.meetings")
    assert rows == [{"title": "기존 회의", "owner_user_id": None}]
    assert len(q(f"SELECT 1 FROM {temp_schema}.transcript_segments")) == 1


# ------------------------------------------------- 011: personal organization

# Everything before filing became personal. A database at this point has the
# global tree and `meetings.category_id`, which is what 011 has to move.
BEFORE_PERSONAL = tuple(v for v in VERSIONS if not v.startswith("011"))


def _filed(schema: str, paths: list[tuple[str, str | None]], owner: str | None = "user") -> dict:
    """A pre-011 database with a global category tree and one filed meeting.

    `paths` is [(name, parent_name)] in creation order.
    -> {"meeting": id, "categories": {name: id}, "users": {username: id}}
    """
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"CREATE SCHEMA {schema}")
        c.execute(f"SET search_path TO {schema}, public")
        for version in BEFORE_PERSONAL:
            c.execute((migrate.MIGRATIONS / f"{version}.sql").read_text(encoding="utf-8")
                      .replace("{{SCHEMA}}", schema))
        users = {
            r["username"]: r["id"]
            for r in c.execute("SELECT id, username FROM users").fetchall()
        }
        cats: dict[str, int] = {}
        for name, parent in paths:
            cats[name] = c.execute(
                "INSERT INTO meeting_categories (name, parent_id) VALUES (%s,%s) RETURNING id",
                (name, cats.get(parent) if parent else None),
            ).fetchone()["id"]
        leaf = paths[-1][0] if paths else None
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status,"
            " category_id, owner_user_id) VALUES ('정산 회의','a.wav','a.wav','COMPLETED',%s,%s)"
            " RETURNING id",
            (cats.get(leaf), users.get(owner) if owner else None),
        ).fetchone()["id"]
        c.commit()
    return {"meeting": mid, "categories": cats, "users": users}


def _tree(schema: str, user_id: int) -> dict[str, str | None]:
    """{category name: parent name} for one account."""
    rows = q(
        f"SELECT k.name, p.name AS parent FROM {schema}.user_categories k"
        f" LEFT JOIN {schema}.user_categories p ON p.id = k.parent_id"
        " WHERE k.user_id = %s",
        (user_id,),
    )
    return {r["name"]: r["parent"] for r in rows}


def test_011_moves_the_owners_filing_into_their_own_tree(temp_schema):
    """`meetings.category_id` says how the owner filed their own meeting, so it
    becomes the owner's personal filing and nobody else's."""
    legacy = _filed(temp_schema, [("업무", None), ("구매부", "업무")])

    assert "011_personal_organization" in migrate.run(temp_schema)

    me = legacy["users"]["user"]
    # the ancestor comes with it, so the hierarchy survives rather than flattening
    assert _tree(temp_schema, me) == {"업무": None, "구매부": "업무"}
    filed = q(
        f"SELECT f.meeting_id, k.name FROM {temp_schema}.user_meeting_filing f"
        f" JOIN {temp_schema}.user_categories k ON k.id = f.category_id"
        " WHERE f.user_id = %s",
        (me,),
    )
    assert filed == [{"meeting_id": legacy["meeting"], "name": "구매부"}]
    # nobody else gets one: the old column proves nothing about another account
    others = q(
        f"SELECT count(*) AS n FROM {temp_schema}.user_categories WHERE user_id <> %s", (me,)
    )
    assert others[0]["n"] == 0


def test_011_leaves_the_old_global_filing_exactly_where_it_was(temp_schema):
    """Additive only. The column and the table stay; nothing is dropped."""
    legacy = _filed(temp_schema, [("업무", None)])
    migrate.run(temp_schema)

    assert "category_id" in columns(temp_schema, "meetings")
    assert q(f"SELECT category_id FROM {temp_schema}.meetings") == [
        {"category_id": legacy["categories"]["업무"]}
    ]
    assert q(f"SELECT name FROM {temp_schema}.meeting_categories") == [{"name": "업무"}]


def test_011_skips_a_meeting_whose_owner_could_not_be_proven(temp_schema):
    """An orphan has nobody to give the filing to, and inventing one would hand
    a stranger's arrangement to an account that never made it."""
    _filed(temp_schema, [("업무", None)], owner=None)
    migrate.run(temp_schema)

    assert q(f"SELECT count(*) AS n FROM {temp_schema}.user_categories")[0]["n"] == 0
    assert q(f"SELECT count(*) AS n FROM {temp_schema}.user_meeting_filing")[0]["n"] == 0


def test_011_is_a_no_op_on_a_second_run(temp_schema):
    _filed(temp_schema, [("업무", None), ("구매부", "업무")])
    migrate.run(temp_schema)
    before = q(f"SELECT user_id, name, parent_id FROM {temp_schema}.user_categories ORDER BY name")

    assert migrate.run(temp_schema) == []
    assert q(
        f"SELECT user_id, name, parent_id FROM {temp_schema}.user_categories ORDER BY name"
    ) == before
    assert q(f"SELECT count(*) AS n FROM {temp_schema}.user_meeting_filing")[0]["n"] == 1


def test_a_filing_cannot_name_another_accounts_category(temp_schema):
    """The composite foreign key carries user_id into the reference, so this is
    refused by PostgreSQL rather than by remembering to check."""
    legacy = _filed(temp_schema, [("업무", None)])
    migrate.run(temp_schema)
    mine = legacy["users"]["user"]
    theirs = legacy["users"]["user2"]
    cat = q(f"SELECT id FROM {temp_schema}.user_categories WHERE user_id = %s", (mine,))[0]["id"]

    with psycopg.connect(db.conninfo()) as c:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            c.execute(
                f"INSERT INTO {temp_schema}.user_meeting_filing (user_id, meeting_id, category_id)"
                " VALUES (%s,%s,%s)",
                (theirs, legacy["meeting"], cat),
            )


def test_a_chat_cannot_be_filed_in_another_accounts_category(temp_schema):
    legacy = _filed(temp_schema, [("업무", None)])
    migrate.run(temp_schema)
    mine, theirs = legacy["users"]["user"], legacy["users"]["user2"]
    cat = q(f"SELECT id FROM {temp_schema}.user_categories WHERE user_id = %s", (mine,))[0]["id"]

    with psycopg.connect(db.conninfo()) as c:
        sid = c.execute(
            f"INSERT INTO {temp_schema}.chat_sessions (user_id) VALUES (%s) RETURNING id",
            (theirs,),
        ).fetchone()[0]
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            c.execute(
                f"UPDATE {temp_schema}.chat_sessions SET category_id = %s WHERE id = %s",
                (cat, sid),
            )


def test_two_accounts_may_use_the_same_category_name(temp_schema):
    """Uniqueness is per account now. Both may have a 업무 folder; neither may
    have two."""
    legacy = _filed(temp_schema, [("업무", None)])
    migrate.run(temp_schema)
    theirs = legacy["users"]["user2"]

    with psycopg.connect(db.conninfo()) as c:
        c.execute(
            f"INSERT INTO {temp_schema}.user_categories (user_id, name) VALUES (%s,'업무')",
            (theirs,),
        )
        c.commit()
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute(
                f"INSERT INTO {temp_schema}.user_categories (user_id, name) VALUES (%s,'업무')",
                (theirs,),
            )
    assert len(q(f"SELECT 1 FROM {temp_schema}.user_categories WHERE name = '업무'")) == 2


def test_deleting_an_account_takes_its_arrangement_and_nothing_else(temp_schema):
    """A tree and a filing are that account's own, so they go with it. The
    meeting does not — 009 already made that an orphan rather than a deletion."""
    legacy = _filed(temp_schema, [("업무", None)])
    migrate.run(temp_schema)

    with psycopg.connect(db.conninfo()) as c:
        c.execute(f"DELETE FROM {temp_schema}.users WHERE id = %s", (legacy["users"]["user"],))

    assert q(f"SELECT count(*) AS n FROM {temp_schema}.user_categories")[0]["n"] == 0
    assert q(f"SELECT count(*) AS n FROM {temp_schema}.user_meeting_filing")[0]["n"] == 0
    assert q(f"SELECT title FROM {temp_schema}.meetings") == [{"title": "정산 회의"}]
