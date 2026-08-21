"""Raw psycopg access. No ORM.

Schema DDL lives in `scripts/migrations/` and is applied by `scripts/migrate.py`.
Nothing in this module creates or alters a table.
"""
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


def conninfo() -> str:
    return (
        f"host={config.DB_HOST} port={config.DB_PORT} dbname={config.DB_NAME} "
        f"user={config.DB_USER} password={config.DB_PASSWORD}"
    )


def init_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=conninfo(),
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
