"""Revisions of an approved set of minutes.

An approved transcript is what every chunk, every fact, and every citation rests
on, so correcting one cannot mean rewriting the text under a live index. A
correction is a new *version* instead:

    v1 PUBLISHED ──[회의록 수정]──> v2 DRAFT      v1 still answers every question
                 ──[승인]────────> v2 INDEXING   v1 still answers every question
                 ──[색인 성공]───> v2 PUBLISHED  v1 becomes SUPERSEDED
                 ──[색인 실패]───> v2 DRAFT      v1 never stopped answering

The guarantee in the right-hand column is the whole point, and it is structural
rather than careful: `chunks` and `meeting_facts` are only ever replaced inside
the one transaction that also flips the version rows, and the embeddings are
computed before that transaction opens. There is no window in which the old
index is gone and the new one has not arrived.

Two constraints in migration 009 carry the invariants, so no code here has to
check them: at most one PUBLISHED version per meeting, and at most one open
(DRAFT or INDEXING) one.
"""
from app.db import conn

# The transcript is copied per version; speakers are not. A speaker is the same
# person across revisions — `meeting_user_speakers` and `meeting_fact_participants`
# both point at that identity — and renaming one is a correction to how they are
# labelled, not a different participant.
#
# ponytail: a rename made while a draft is open relabels the published version's
# sources too, because `speakers.display_name` is resolved at read time while the
# published chunk text was rendered at index time. Publishing the draft rebuilds
# the chunks and the two agree again. Revisit when a rename has to be stageable,
# which needs a per-version speakers table and a rewrite of both foreign keys.
COPY_SEGMENTS = """
    INSERT INTO transcript_segments
           (meeting_id, speaker_id, version, sequence, start_time, end_time, text)
    SELECT meeting_id, speaker_id, %(to)s, sequence, start_time, end_time, text
      FROM transcript_segments
     WHERE meeting_id = %(mid)s AND version = %(from)s
"""


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


def create_draft(meeting_id: int, user_id: int) -> int:
    """Start a revision from the published minutes. -> the new version number.

    The transcript is copied in SQL, so the draft starts as an exact duplicate of
    what is published and the reviewer only changes what is wrong. Nothing about
    the published version moves: it keeps its rows, its chunks, its facts, and
    its place in every search until the draft is approved and indexed.

    The version number is computed inside the INSERT and the primary key refuses
    a collision, so two simultaneous requests cannot fork the minutes — and the
    partial unique index refuses the second draft even at a different number.
    """
    with conn() as c:
        source = published(meeting_id, c)
        if not source:
            raise ValueError("published version missing")
        version = c.execute(
            "INSERT INTO meeting_versions (meeting_id, version, status, created_by_user_id)"
            " SELECT %s, coalesce(max(version), 0) + 1, 'DRAFT', %s"
            "   FROM meeting_versions WHERE meeting_id = %s"
            " RETURNING version",
            (meeting_id, user_id, meeting_id),
        ).fetchone()["version"]
        c.execute(COPY_SEGMENTS, {"mid": meeting_id, "from": source, "to": version})
    return version


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


def discard(meeting_id: int, version: int) -> bool:
    """Throw away an unapproved revision and its transcript copy.

    Only a DRAFT above version 1: version 1 is the meeting's only minutes, and
    discarding it would leave a meeting with no transcript at all. The published
    version is not touched, because a draft never touched it.
    """
    with conn() as c:
        row = c.execute(
            "DELETE FROM meeting_versions"
            " WHERE meeting_id = %s AND version = %s AND status = 'DRAFT' AND version > 1"
            " RETURNING version",
            (meeting_id, version),
        ).fetchone()
        if row:
            c.execute(
                "DELETE FROM transcript_segments WHERE meeting_id = %s AND version = %s",
                (meeting_id, version),
            )
    return bool(row)


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
