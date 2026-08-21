"""Build the lexical index for rows that already have an embedding.

    python -m scripts.backfill_lexemes            # every row that is missing it
    python -m scripts.backfill_lexemes --all      # every row, recomputed

Migration 007 added `lexemes` to `chunks` and `meeting_facts` as a nullable
column, because Kiwi is Python and a `.sql` file cannot call it. This is the
other half of that migration.

It is deliberately NOT the re-embedding endpoint, and it must not become one:

* re-embedding re-chunks a meeting and rewrites 1024-dimensional vectors, which
  is expensive and invalidates nothing else;
* this reads `content` / `source_text` that is already stored, writes one text
  column, and never loads BGE-M3 or calls an LLM.

A meeting whose vectors are still valid therefore does not need re-embedding to
become lexically searchable, and a fact does not need re-extracting.

`source_segment_ids` on a chunk is not backfilled: it is provenance, and the
segment ids a stored chunk came from are not recoverable from its rendered text.
A meeting that needs them re-indexes (POST /api/meetings/{id}/reindex).
"""
import argparse
import logging

from app.db import conn
from app.services import intelligence, lexical

log = logging.getLogger("minutes.backfill")

def _fact_text(row: dict) -> str:
    """Rebuild what `intelligence.store` lexicalizes, from stored columns only."""
    labels = [f"[{intelligence.TYPE_LABEL[row['fact_type']]}] {row['content']}"]
    labels += [
        f"{intelligence.ROLE_LABEL[r['role']]}: {r['display_name'] or r['speaker_code']}"
        for r in row["participants"]
    ]
    if row["deadline_text"]:
        labels.append(f"기한: {row['deadline_text']}")
    return " / ".join(labels) + "\n" + row["source_text"]


def run(recompute: bool = False) -> dict[str, int]:
    """-> {table: rows written}. Idempotent; safe to run while the app is up."""
    missing = not recompute
    done = {}
    with conn() as c:
        chunks = c.execute(
            "SELECT id, content FROM chunks WHERE %s IS FALSE OR lexemes IS NULL",
            (missing,),
        ).fetchall()
        for r in chunks:
            c.execute(
                "UPDATE chunks SET lexemes = %s WHERE id = %s",
                (lexical.lexemes(r["content"]), r["id"]),
            )
        done["chunks"] = len(chunks)

        facts = c.execute(
            "SELECT f.id, f.fact_type, f.content, f.deadline_text, f.source_text,"
            " coalesce(json_agg(json_build_object('role', p.role,"
            "   'display_name', s.display_name, 'speaker_code', s.speaker_code)"
            "   ORDER BY p.role) FILTER (WHERE p.fact_id IS NOT NULL), '[]') AS participants"
            " FROM meeting_facts f"
            " LEFT JOIN meeting_fact_participants p ON p.fact_id = f.id"
            " LEFT JOIN speakers s ON s.id = p.speaker_id"
            " WHERE %s IS FALSE OR f.lexemes IS NULL"
            " GROUP BY f.id",
            (missing,),
        ).fetchall()
        for r in facts:
            c.execute(
                "UPDATE meeting_facts SET lexemes = %s WHERE id = %s",
                (lexical.lexemes(_fact_text(r)), r["id"]),
            )
        done["meeting_facts"] = len(facts)
    return done


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Kiwi lexical index backfill")
    ap.add_argument("--all", action="store_true",
                    help="recompute every row, not only the ones missing lexemes")
    args = ap.parse_args()
    written = run(recompute=args.all)
    print(", ".join(f"{table}: {n} row(s)" for table, n in written.items()))
