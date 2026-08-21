"""Rank fusion: how two retrieval axes and one metadata signal become one order.

Kept out of both `rag` and `intelligence` because both layers fuse the same way,
and a chunk ranking and a fact ranking must not drift apart. Nothing here talks
to the database.
"""
from app.services import lexical

# How many candidates each axis contributes before fusion, per layer. Wider than
# the six that reach the model on purpose: fusion can only reorder what it was
# given, and a chunk that dense ranks 14th and lexical ranks 2nd is exactly the
# one this is here to promote. Measured at 30 — see docs/decisions/.
CANDIDATES = 30

# The RRF constant from Cormack, Clarke & Buettcher (2009), where 60 was found to
# work across TREC runs without tuning. It damps the top of each list: the gap
# between rank 1 and rank 2 stops being worth more than every rank below it.
RRF_K = 60

# One metadata agreement is worth one first-place finish in one axis, expressed in
# the same units RRF produces so the two are commensurable. Metadata never
# removes a candidate — an entity guess is not reliable enough to hard-filter on.
# The chat scope stays the only hard filter, and it is applied in SQL.
META_BOOST = 1 / (RRF_K + 1)

# "dense" is the retrieval this application had before lexical search existed,
# kept runnable so the baseline stays reproducible rather than remembered.
MODES = ("dense", "lexical", "hybrid", "hybrid+meta")
RETRIEVAL_MODE = "hybrid+meta"


# How much of a meeting's title the question has to name before "this question is
# about that meeting" is a signal rather than a coincidence. Measured: at 0 the
# boost fired on a single shared token — "월 350만원" matched every title
# containing "8월" — and cost more than it gained (see docs/decisions/).
TITLE_MATCH = 0.5


def meta_hits(row: dict, asked: set[str]) -> int:
    """How many of this row's own metadata values the question actually names.

    The direction matters: this never extracts an entity from the question and
    then trusts it. It compares what the database already holds for the candidate
    against the words that were typed, so a "speaker" can only ever be a speaker
    this meeting really has and a date can only be a meeting's real date.

    Each of the three signals demands agreement rather than overlap, because a
    one-token coincidence is common in a corpus where every title contains a
    month and every question contains a number:

    * speaker  every morpheme of the stored display name was typed
    * meeting  the question names at least half of the title's morphemes
    * date     the question names both the month and the day the meeting was held
    """
    hits = 0
    if any(
        (t := set(lexical.tokens(name))) and t <= asked
        for name in row.get("speakers") or []
    ):
        hits += 1
    title = set(lexical.tokens(row["meeting_title"]))
    if title and len(title & asked) / len(title) >= TITLE_MATCH:
        hits += 1
    at = row.get("meeting_at")
    # A date nobody entered is a registration date. A question that names a date
    # is asking about when the meeting happened, which this row cannot claim.
    if at and row.get("meeting_at_known") and {str(at.month), str(at.day)} <= asked:
        hits += 1
    return hits


def fuse(rows_dense: list[dict], rows_lexical: list[dict], question: str,
         top_k: int, mode: str) -> list[dict]:
    """Reciprocal Rank Fusion over the two axes, then metadata, then Top-K.

        score(d) = sum over axes of 1 / (RRF_K + rank of d in that axis)

    A document missing from an axis simply contributes nothing for it, which is
    why this needs no score normalization and no per-axis weight: the two axes
    are never compared by magnitude, only by position.

    `mode` exists so the baseline stays runnable. "dense" and "lexical" order by
    that one axis's own score and are how BEFORE/AFTER are measured against the
    same corpus; "hybrid" fuses; "hybrid+meta" then adds the metadata agreement.
    """
    if mode == "dense":
        return rows_dense[:top_k]
    if mode == "lexical":
        return rows_lexical[:top_k]

    rows = {r["id"]: r for r in rows_lexical}
    rows.update({r["id"]: r for r in rows_dense})  # prefer the dense row's score
    fused: dict[int, float] = {}
    for ranking in (rows_dense, rows_lexical):
        for position, r in enumerate(ranking, 1):
            fused[r["id"]] = fused.get(r["id"], 0.0) + 1 / (RRF_K + position)
    if mode == "hybrid+meta":
        asked = set(lexical.tokens(question))
        for rid, row in rows.items():
            fused[rid] += META_BOOST * meta_hits(row, asked)

    out = []
    for rid, score in sorted(fused.items(), key=lambda kv: -kv[1])[:top_k]:
        rows[rid]["score"] = round(score, 6)
        out.append(rows[rid])
    return out
