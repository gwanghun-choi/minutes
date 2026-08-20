"""Raw psycopg access. No ORM - the schema is four tables."""
from contextlib import contextmanager

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app import config

_pool: ConnectionPool | None = None


def _configure(conn: psycopg.Connection) -> None:
    conn.execute(f"SET search_path TO {config.DB_SCHEMA}, public")
    register_vector(conn)
    conn.commit()


def init_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=(
                f"host={config.DB_HOST} port={config.DB_PORT} dbname={config.DB_NAME} "
                f"user={config.DB_USER} password={config.DB_PASSWORD}"
            ),
            min_size=1,
            max_size=8,
            kwargs={"row_factory": dict_row},
            configure=_configure,
            open=True,
        )
    return _pool


@contextmanager
def conn():
    with init_pool().connection() as c:
        yield c


def _plain_conn(**kw) -> psycopg.Connection:
    """Standalone connection - used for DDL, before the pool can register vector."""
    return psycopg.connect(
        host=config.DB_HOST, port=config.DB_PORT, dbname=config.DB_NAME,
        user=config.DB_USER, password=config.DB_PASSWORD, row_factory=dict_row, **kw,
    )


def apply_schema(embedding_dim: int) -> None:
    """Idempotent DDL. Only ever touches the `minutes` schema."""
    sql = (config.BASE_DIR / "scripts" / "init_db.sql").read_text()
    sql = sql.replace("{{SCHEMA}}", config.DB_SCHEMA).replace("{{DIM}}", str(embedding_dim))
    with _plain_conn(autocommit=True) as c:
        c.execute(sql)

    # Guard: an older run may have created chunks with a different dimension.
    with _plain_conn() as c:
        row = c.execute(
            """
            SELECT a.atttypmod AS dim
            FROM pg_attribute a
            JOIN pg_class t ON t.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = %s AND t.relname = 'chunks' AND a.attname = 'embedding'
            """,
            (config.DB_SCHEMA,),
        ).fetchone()
    if row and row["dim"] not in (embedding_dim, -1):
        raise RuntimeError(
            f"{config.DB_SCHEMA}.chunks.embedding is vector({row['dim']}) but the embedding "
            f"model produces {embedding_dim} dims. Drop the table or change EMBEDDING_MODEL."
        )
