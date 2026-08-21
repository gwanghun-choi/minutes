"""Explicit database migration. The application never applies DDL.

Deployment runs this once, before the application starts:

    python -m scripts.migrate

Every file in `migrations/` is applied in filename order, exactly once, inside
its own transaction together with its `schema_migrations` row. A failure rolls
the file back and records nothing, so a re-run retries the same migration rather
than skipping it. Nothing here ever drops or resets an existing object.
"""
import logging
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from app import config, db

log = logging.getLogger("minutes.migrate")

MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def _files() -> list[tuple[str, str, Path]]:
    """(version, name, path) in filename order. `003_user_identity.sql` -> 003, user_identity."""
    out = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        version, _, name = path.stem.partition("_")
        out.append((version, name, path))
    return out


def run(schema: str | None = None) -> list[str]:
    """Apply every pending migration. Returns what was applied, newest last.

    `schema` defaults to the configured one; passing it lets a test migrate a
    throwaway schema without reconfiguring the process around the real data.
    """
    schema = schema or config.DB_SCHEMA
    done: list[str] = []
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        c.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        c.execute(
            f"CREATE TABLE IF NOT EXISTS {schema}.schema_migrations ("
            " version TEXT PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
        c.commit()
        applied = {
            r["version"]
            for r in c.execute(f"SELECT version FROM {schema}.schema_migrations").fetchall()
        }
        for version, name, path in _files():
            if version in applied:
                continue
            sql = path.read_text(encoding="utf-8").replace("{{SCHEMA}}", schema)
            try:
                c.execute(sql)
                c.execute(
                    f"INSERT INTO {schema}.schema_migrations (version, name) VALUES (%s,%s)",
                    (version, name),
                )
                c.commit()
            except Exception:
                c.rollback()
                log.error("migration %s_%s failed - not recorded, nothing applied", version, name)
                raise
            log.info("applied %s_%s", version, name)
            done.append(f"{version}_{name}")
    return done


def verify(embedding_dim: int, schema: str | None = None) -> None:
    """Read-only startup check. Never mutates the schema.

    An unmigrated database must fail with a sentence an operator can act on,
    not with a missing-relation error halfway through the first request. Uses a
    standalone connection, not the pool: on a fresh database the pool cannot even
    register the vector type yet.
    """
    schema = schema or config.DB_SCHEMA
    expected = [version for version, _, _ in _files()]
    with psycopg.connect(db.conninfo(), row_factory=dict_row) as c:
        present = c.execute(
            "SELECT to_regclass(%s) AS t", (f"{schema}.schema_migrations",)
        ).fetchone()["t"]
        applied = (
            {
                r["version"]
                for r in c.execute(f"SELECT version FROM {schema}.schema_migrations").fetchall()
            }
            if present
            else set()
        )
        missing = [v for v in expected if v not in applied]
        if missing:
            raise RuntimeError(
                f"DB migration이 필요합니다. 적용되지 않은 migration: {', '.join(missing)}. "
                "`python -m scripts.migrate`를 먼저 실행하세요."
            )

        # The vector column width is fixed by migration 001; a different embedding
        # model would silently write vectors that can never be compared.
        row = c.execute(
            """
            SELECT a.atttypmod AS dim
            FROM pg_attribute a
            JOIN pg_class t ON t.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = %s AND t.relname = 'chunks' AND a.attname = 'embedding'
            """,
            (schema,),
        ).fetchone()
    if row and row["dim"] not in (embedding_dim, -1):
        raise RuntimeError(
            f"{schema}.chunks.embedding is vector({row['dim']}) but the embedding "
            f"model produces {embedding_dim} dims. Drop the table or change EMBEDDING_MODEL."
        )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    applied = run()
    print(f"applied {len(applied)} migration(s): {', '.join(applied) or 'none'}")
