"""Which revision of a meeting's minutes is the published one.

A meeting has one revision. It opens as a DRAFT with the meeting itself, holds
the AI transcript while a person corrects it, and becomes PUBLISHED when they
approve it:

    v1 DRAFT ──[승인]──────> v1 INDEXING
             ──[색인 성공]─> v1 PUBLISHED   the minutes, from here on unchanged
             ──[색인 실패]─> v1 DRAFT       back to the reviewer, nothing lost

**Approved minutes are immutable**, so nothing in this module starts a second
revision — the product has no action that does. The version machinery stays for
two reasons that are not features: `chunks`, `meeting_facts`, and
`transcript_segments` all carry a version, and a database that ran an earlier
build may hold a v2 whose transcript an old citation still rests on. Those rows
are read (`history`, `published`) and never rewritten.

The publish itself is still structural rather than careful: `chunks` and
`meeting_facts` are replaced inside the one transaction that also flips the
version row, and the embeddings are computed before that transaction opens. A
failure anywhere leaves the previous state intact.

Two constraints in migration 009 carry the invariants, so no code here has to
check them: at most one PUBLISHED version per meeting, and at most one open
(DRAFT or INDEXING) one.

Speakers are not versioned. A speaker is the same person across revisions —
`meeting_user_speakers` and `meeting_fact_participants` both point at that
identity — and renaming one before approval is a correction to how they are
labelled, not a different participant.
"""
from app.db import conn


def published(meeting_id: int, c=None) -> int | None:
    """The version the application shows and searches, or None before the first
    approval."""
    return _scalar(
        "SELECT version FROM meeting_versions"
        " WHERE meeting_id = %s AND status = 'PUBLISHED'",
        (meeting_id,), c,
    )


def open_version(meeting_id: int, c=None) -> dict | None:
    """The revision being edited or indexed, or None. -> {version, status}"""
    return _row(
        "SELECT version, status FROM meeting_versions"
        " WHERE meeting_id = %s AND status IN ('DRAFT', 'INDEXING')",
        (meeting_id,), c,
    )


def current(meeting_id: int, c=None) -> int:
    """The version to read when nobody said which: published, else the open one,
    else 1. Never guesses at a row that does not exist."""
    if v := published(meeting_id, c):
        return v
    row = open_version(meeting_id, c)
    return row["version"] if row else 1


def start(meeting_id: int, user_id: int | None, c) -> int:
    """Open version 1 for a freshly uploaded meeting. Called inside the insert."""
    return c.execute(
        "INSERT INTO meeting_versions (meeting_id, version, status, created_by_user_id)"
        " VALUES (%s, 1, 'DRAFT', %s) RETURNING version",
        (meeting_id, user_id),
    ).fetchone()["version"]



def claim(meeting_id: int, c) -> int | None:
    """Move the open draft into INDEXING, or return None. Compare-and-set.

    The same mutual exclusion the meeting status uses: only one UPDATE can match,
    so a repeated approval is a no-op rather than a second indexing run. Takes an
    open connection because the caller flips `meetings.status` in the same
    transaction for a first approval.
    """
    row = c.execute(
        "UPDATE meeting_versions SET status = 'INDEXING'"
        " WHERE meeting_id = %s AND status = 'DRAFT' RETURNING version",
        (meeting_id,),
    ).fetchone()
    return row["version"] if row else None


def publish(c, meeting_id: int, version: int) -> None:
    """Make `version` the published one. Runs inside the indexing transaction.

    Called in the same transaction that replaced `chunks`, so the index and the
    pointer to it can never disagree — and if anything in that transaction fails,
    both roll back and the previous version is still published with its own index
    intact.

    An upsert, so re-indexing an already published version is idempotent.
    """
    c.execute(
        "UPDATE meeting_versions SET status = 'SUPERSEDED'"
        " WHERE meeting_id = %s AND status = 'PUBLISHED' AND version <> %s",
        (meeting_id, version),
    )
    c.execute(
        "INSERT INTO meeting_versions (meeting_id, version, status, published_at)"
        " VALUES (%s, %s, 'PUBLISHED', now())"
        " ON CONFLICT (meeting_id, version)"
        "   DO UPDATE SET status = 'PUBLISHED', published_at = now()",
        (meeting_id, version),
    )


def release(meeting_id: int, version: int) -> None:
    """Indexing failed: hand the revision back to the reviewer as a draft.

    Only an INDEXING row moves. A re-index of the published version fails through
    here too, and that row must stay PUBLISHED — it is still serving the index
    the failed run never touched.
    """
    with conn() as c:
        c.execute(
            "UPDATE meeting_versions SET status = 'DRAFT'"
            " WHERE meeting_id = %s AND version = %s AND status = 'INDEXING'",
            (meeting_id, version),
        )



def history(meeting_id: int, c=None) -> list[dict]:
    """Every revision, newest first, with who started it and when it went live."""
    sql = (
        "SELECT v.version, v.status, v.created_at, v.published_at,"
        " u.display_name AS created_by,"
        " (SELECT count(*) FROM transcript_segments t"
        "   WHERE t.meeting_id = v.meeting_id AND t.version = v.version) AS segment_count"
        " FROM meeting_versions v"
        " LEFT JOIN users u ON u.id = v.created_by_user_id"
        " WHERE v.meeting_id = %s ORDER BY v.version DESC"
    )
    if c is not None:
        return c.execute(sql, (meeting_id,)).fetchall()
    with conn() as c2:
        return c2.execute(sql, (meeting_id,)).fetchall()


def _row(sql: str, args: tuple, c=None) -> dict | None:
    if c is not None:
        return c.execute(sql, args).fetchone()
    with conn() as c2:
        return c2.execute(sql, args).fetchone()


def _scalar(sql: str, args: tuple, c=None):
    row = _row(sql, args, c)
    return row["version"] if row else None
