"""Retrieval evaluation. Measures the change instead of asserting it.

    python -m scripts.evaluate                     # every mode, retrieval only
    python -m scripts.evaluate --generation        # also score answers (needs an API key)
    python -m scripts.evaluate --mode dense        # one mode
    python -m scripts.evaluate --keep              # leave the schema in place

Everything runs in a throwaway PostgreSQL schema (`minutes_eval`), created and
dropped here, exactly as tests/test_migrate.py does. The real `minutes` schema is
never opened: the connection pool is configured before it is first used, and the
run aborts if something already opened it.

Embeddings are the real BAAI/bge-m3 and lexemes are the real Kiwi. A stubbed
embedding would make every cosine distance a property of the stub, and the
numbers below would measure nothing.

The retrieval metrics deliberately skip `rag.plan`: query rewriting and fact-type
filtering are an LLM call whose output varies between runs, and mixing them in
would stop the four modes from being comparable. --generation runs the whole
path, planner included, for the two questions retrieval metrics cannot score.
"""
import argparse
import datetime as dt
import logging
import time
from collections import defaultdict

import psycopg

from app import config, db

SCHEMA = "minutes_eval"
TOP_K = 6

log = logging.getLogger("minutes.evaluate")


def _standalone(sql: str) -> None:
    """DDL on the throwaway schema, outside the pool."""
    with psycopg.connect(db.conninfo(), autocommit=True) as c:
        c.execute(sql)


def use_eval_schema() -> None:
    if db._pool is not None:
        raise RuntimeError("the connection pool is already open on another schema")
    config.DB_SCHEMA = SCHEMA
    from scripts import migrate

    migrate.run(SCHEMA)


# ----------------------------------------------------------------- corpus load


def load_corpus() -> dict[str, int]:
    """Build the fixture corpus. -> {corpus key: meeting_id}.

    Uses the production writers and nothing else: `_persist_transcript` for the
    draft, `index_transcript` for the chunks and both of their indexes,
    `intelligence.store` for the facts. A fixture built by a second code path
    would be measuring that second path.
    """
    from app.db import conn
    from app.services import intelligence, pipeline, versions

    from scripts.eval_data import CORPUS

    ids: dict[str, int] = {}
    for meeting in CORPUS:
        held = meeting["held_at"]
        with conn() as c:
            mid = c.execute(
                "INSERT INTO meetings (title, original_filename, stored_filename, status,"
                " held_at) VALUES (%s,'eval.wav','eval.wav','REVIEW_REQUIRED',%s)"
                " RETURNING id",
                (meeting["title"], held),
            ).fetchone()["id"]
            # No owner: the harness runs on its own throwaway schema with no
            # accounts in it, and retrieval is measured with `user_id=None`,
            # which is the "no access filter" path. Nothing here goes through an
            # API, so no permission is being bypassed.
            versions.start(mid, None, c)
        pipeline._persist_transcript(mid, [
            {"start": i * 5.0, "end": i * 5.0 + 4.0, "text": text, "speaker": code}
            for i, (code, text) in enumerate(meeting["lines"])
        ])
        # The reviewer's rename, which is what puts real names into the index.
        with conn() as c:
            for code, name in meeting["speakers"].items():
                c.execute(
                    "UPDATE speakers SET display_name = %s"
                    " WHERE meeting_id = %s AND speaker_code = %s",
                    (name, mid, code),
                )
        pipeline.set_status(mid, "INDEXING")
        pipeline.index_transcript(mid, 1)

        utterances, _ = pipeline.load_transcript(mid, 1)
        base = dt.date.fromisoformat(held) if held else dt.date.today()
        by_name = {u["display_name"]: u["speaker_id"] for u in utterances}
        names = {u["speaker_id"]: u["display_name"] for u in utterances}
        facts = []
        for kind, content, segs, roles, deadline, status in meeting["facts"]:
            picked = [utterances[i] for i in segs]
            facts.append({
                "fact_type": kind,
                "content": content,
                "status": status,
                "deadline_text": deadline,
                "deadline_at": intelligence.deadline_date(deadline, base),
                "start_time": picked[0]["start"],
                "end_time": picked[-1]["end"],
                "source_segment_ids": [u["id"] for u in picked],
                "source_text": "\n".join(f"{u['display_name']}: {u['text']}" for u in picked),
                "participants": {r: by_name[n] for r, n in roles.items()},
            })
        intelligence.store(mid, facts, names, 1)
        ids[meeting["key"]] = mid
        log.info("loaded %s (meeting %s, %s utterances)", meeting["key"], mid, len(utterances))
    return ids


def segment_ids(ids: dict[str, int]) -> dict[str, list[int]]:
    """{corpus key: [segment id per line index]}, so a fixture can name a line."""
    from app.db import conn

    out = {}
    with conn() as c:
        for key, mid in ids.items():
            out[key] = [
                r["id"] for r in c.execute(
                    "SELECT id FROM transcript_segments WHERE meeting_id = %s"
                    " ORDER BY sequence", (mid,),
                ).fetchall()
            ]
    return out


# --------------------------------------------------------------------- metrics


def ranked(question: str, mode: str) -> list[dict]:
    """Both layers, in one ranking, as retrieval ordered them.

    The chronological reordering `intelligence.search` applies is presentation:
    it decides what the model reads first, not what retrieval found. Sorting by
    score here measures the retrieval.
    """
    from app.services import intelligence, rag

    facts = intelligence.search(question, None, None, None, None, TOP_K, mode)
    chunks = rag.search(question, None, TOP_K, mode)
    return sorted(facts + chunks, key=lambda r: -r["score"])


def score_question(rows: list[dict], want_segments: set[int], want_meetings: set[int],
                   want_speaker: str | None) -> dict:
    first = 0
    for position, r in enumerate(rows, 1):
        if set(r.get("source_segment_ids") or []) & want_segments:
            first = position
            break
    return {
        "hit@1": float(first == 1),
        "hit@3": float(0 < first <= 3),
        "hit@5": float(0 < first <= 5),
        "mrr": 1 / first if first else 0.0,
        "meeting@5": float(any(r["meeting_id"] in want_meetings for r in rows[:5])),
        "speaker@5": (
            float(any(want_speaker in (r.get("speakers") or []) for r in rows[:5]))
            if want_speaker else None
        ),
    }


METRICS = ("hit@1", "hit@3", "hit@5", "mrr", "meeting@5", "speaker@5")


def evaluate(mode: str, ids: dict[str, int], segments: dict[str, list[int]]) -> dict:
    from scripts.eval_data import QUESTIONS

    per_category: dict[str, list[dict]] = defaultdict(list)
    overall: list[dict] = []
    elapsed: list[float] = []
    for question, category, expect, speaker in QUESTIONS:
        if not expect:  # no-answer questions are scored on the answer, not on rank
            continue
        want_segments = {segments[k][i] for k, idx in expect.items() for i in idx}
        want_meetings = {ids[k] for k in expect}
        start = time.perf_counter()
        rows = ranked(question, mode)
        elapsed.append((time.perf_counter() - start) * 1000)
        scored = score_question(rows, want_segments, want_meetings, speaker)
        per_category[category].append(scored)
        overall.append(scored)
    return {"overall": overall, "by_category": per_category, "ms": elapsed}


def mean(values: list) -> float | None:
    real = [v for v in values if v is not None]
    return sum(real) / len(real) if real else None


def aggregate(rows: list[dict]) -> dict:
    return {m: mean([r[m] for r in rows]) for m in METRICS}


def cell(value) -> str:
    return "  -  " if value is None else f"{value:.3f}"


def table(title: str, header: str, lines: list[str]) -> str:
    return f"\n### {title}\n\n{header}\n" + "\n".join(lines)


# ------------------------------------------------------ generation-level checks


def generation_report(mode: str) -> list[str]:
    """No-answer and conflict behaviour, through the whole path including the LLM.

    Reports SKIP, never FAIL, when the LLM is unreachable. `rag.answer` hands back
    the evidence with an explanatory sentence if the API call fails, and scoring
    that sentence would report a broken key as a broken model.
    """
    from app.services import rag

    from scripts.eval_data import CONFLICT_EXPECT, QUESTIONS

    def verdict(ok: bool, answer: str) -> str:
        if answer.startswith("LLM 답변 생성에 실패했습니다") or "OPENAI_API_KEY" in answer:
            return "SKIP"
        return "PASS" if ok else "FAIL"

    lines, refused, asked = [], 0, 0
    for question, category, _, _ in QUESTIONS:
        if category not in ("no_answer", "conflict"):
            continue
        result = rag.answer(question, mode=mode)
        answer = result["answer"]
        if category == "no_answer":
            ok = rag.NO_ANSWER in answer
            state = verdict(ok, answer)
            asked += state != "SKIP"
            refused += state == "PASS"
            shown = "거부" if ok else "답변함"
        else:
            names = CONFLICT_EXPECT[question]
            ok = all(n in answer for n in names)
            state = verdict(ok, answer)
            shown = "양쪽 모두 제시" if ok else "한쪽만/누락"
            shown += f" (conflict 감지: {'예' if rag.has_conflict(result['sources']) else '아니오'})"
        lines.append(f"| {category} | {question} |"
                     f" {'측정 불가 (LLM 호출 실패)' if state == 'SKIP' else shown} | {state} |")
    lines.append(
        f"| **no-answer accuracy** | {refused}/{asked} |"
        + (f" {refused / asked:.3f}" if asked else " 측정 불가")
        + " | |"
    )
    return lines


def chunking_report(ids: dict[str, int]) -> str:
    """Is the current chunking actually splitting the things a question asks for?

    The criterion is not a token count. It is whether one fact's evidence — a
    request and the segment that carries its assignee, a decision and its
    deadline — survives inside a single chunk, because a chunk is the unit
    retrieval returns.
    """
    from app.db import conn
    from app.services import chunking

    with conn() as c:
        chunks = c.execute(
            "SELECT meeting_id, content, source_segment_ids FROM chunks"
            " ORDER BY meeting_id, sequence"
        ).fetchall()
        facts = c.execute(
            "SELECT meeting_id, fact_type, source_segment_ids FROM meeting_facts"
        ).fetchall()

    by_meeting: dict[int, list[dict]] = defaultdict(list)
    for ch in chunks:
        by_meeting[ch["meeting_id"]].append(ch)

    whole, split = 0, 0
    for f in facts:
        want = set(f["source_segment_ids"])
        if any(want <= set(ch["source_segment_ids"] or []) for ch in by_meeting[f["meeting_id"]]):
            whole += 1
        else:
            split += 1

    tokens = [chunking.approx_tokens(ch["content"]) for ch in chunks]
    covered = sum(len(ch["source_segment_ids"] or []) for ch in chunks)
    segments_total = sum(
        len({s for ch in v for s in (ch["source_segment_ids"] or [])})
        for v in by_meeting.values()
    )
    return "\n".join([
        "\n## Chunk shape\n",
        "| measure | value |",
        "|---|---|",
        f"| TARGET_TOKENS / MAX_TOKENS / MAX_UTTERANCES / OVERLAP |"
        f" {chunking.TARGET_TOKENS} / {chunking.MAX_TOKENS} /"
        f" {chunking.MAX_UTTERANCES} / {chunking.OVERLAP_UTTERANCES} |",
        f"| chunks | {len(chunks)} |",
        f"| approx tokens per chunk (min/mean/max) |"
        f" {min(tokens)} / {sum(tokens) / len(tokens):.0f} / {max(tokens)} |",
        f"| segment copies / distinct segments (overlap cost) |"
        f" {covered} / {segments_total} = {covered / segments_total:.2f}x |",
        f"| facts whose evidence fits in one chunk | {whole}/{whole + split}"
        f" = {whole / (whole + split):.3f} |",
    ])


def latency_report(mode: str) -> list[str]:
    """Where the retrieval milliseconds actually go."""
    from app.services import intelligence, lexical, rag

    question = "SSL 인증서 발급은 누가 하기로 했어?"
    lexical.tokens("warm up the analyzer")
    rag.search_dense(question)  # warm the embedding model

    def timed(fn, n=5):
        start = time.perf_counter()
        for _ in range(n):
            fn()
        return (time.perf_counter() - start) * 1000 / n

    return [
        f"| Kiwi 형태소 분석 | {timed(lambda: lexical.tokens(question)):.1f} |",
        f"| Dense (BGE-M3 + pgvector) | {timed(lambda: rag.search_dense(question)):.1f} |",
        f"| Lexical (Kiwi + FTS) | {timed(lambda: rag.search_lexical(question)):.1f} |",
        f"| Fact dense | {timed(lambda: intelligence.search_dense(question)):.1f} |",
        f"| Fact lexical | {timed(lambda: intelligence.search_lexical(question)):.1f} |",
        f"| 전체 retrieval ({mode}, LLM 제외) |"
        f" {timed(lambda: ranked(question, mode)):.1f} |",
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description="minutes retrieval evaluation")
    ap.add_argument("--mode", action="append", help="one of dense/lexical/hybrid/hybrid+meta")
    ap.add_argument("--generation", action="store_true",
                    help="also score no-answer and conflict answers (calls the LLM)")
    ap.add_argument("--keep", action="store_true", help="do not drop the eval schema")
    ap.add_argument("--rrf-k", type=int, action="append",
                    help="sweep the RRF constant instead of using fusion.RRF_K")
    ap.add_argument("--candidates", type=int, action="append",
                    help="sweep the per-axis candidate count")
    ap.add_argument("--chunking", action="store_true",
                    help="report chunk shape and how often a fact fits in one chunk")
    ap.add_argument("--detail", action="store_true",
                    help="print the first-hit rank of every question, per mode")
    args = ap.parse_args()

    use_eval_schema()
    from app.services import fusion

    from scripts.eval_data import QUESTIONS

    modes = args.mode or list(fusion.MODES)
    try:
        ids = load_corpus()
        segments = segment_ids(ids)
        if args.rrf_k or args.candidates:
            print("\n## Fusion constant sweep (hybrid+meta)\n")
            print("| RRF_K | candidates | " + " | ".join(METRICS) + " |")
            print("|---" * (len(METRICS) + 2) + "|")
            for k in args.rrf_k or [fusion.RRF_K]:
                for n in args.candidates or [fusion.CANDIDATES]:
                    fusion.RRF_K, fusion.CANDIDATES = k, n
                    fusion.META_BOOST = 1 / (k + 1)
                    agg = aggregate(evaluate("hybrid+meta", ids, segments)["overall"])
                    print(f"| {k} | {n} | " + " | ".join(cell(agg[x]) for x in METRICS) + " |")
            return

        if args.chunking:
            print(chunking_report(ids))
            return

        results = {m: evaluate(m, ids, segments) for m in modes}

        print("\n## Retrieval quality\n")
        print("| mode | " + " | ".join(METRICS) + " | ms/query |")
        print("|---" * (len(METRICS) + 2) + "|")
        for m in modes:
            agg = aggregate(results[m]["overall"])
            ms = mean(results[m]["ms"])
            print(f"| {m} | " + " | ".join(cell(agg[k]) for k in METRICS)
                  + f" | {ms:.0f} |")

        print("\n## By question type (hit@3 / MRR)\n")
        categories = sorted({c for _, c, expect, _ in QUESTIONS if expect})
        print("| type | n | " + " | ".join(modes) + " |")
        print("|---" * (len(modes) + 2) + "|")
        for cat in categories:
            n = len(results[modes[0]]["by_category"][cat])
            cells = []
            for m in modes:
                agg = aggregate(results[m]["by_category"][cat])
                cells.append(f"{cell(agg['hit@3'])} / {cell(agg['mrr'])}")
            print(f"| {cat} | {n} | " + " | ".join(cells) + " |")

        if args.detail:
            print("\n## Per-question first-hit rank (0 = not retrieved)\n")
            print("| type | question | " + " | ".join(modes) + " |")
            print("|---" * (len(modes) + 2) + "|")
            for question, category, expect, _ in QUESTIONS:
                if not expect:
                    continue
                want = {segments[k][i] for k, idx in expect.items() for i in idx}
                cells = []
                for m in modes:
                    rows = ranked(question, m)
                    rank = next(
                        (i for i, r in enumerate(rows, 1)
                         if set(r.get("source_segment_ids") or []) & want), 0)
                    cells.append(str(rank))
                print(f"| {category} | {question} | " + " | ".join(cells) + " |")

        print("\n## Retrieval latency (ms, mean of 5)\n")
        print("| stage | ms |")
        print("|---|---|")
        for line in latency_report(modes[-1]):
            print(line)

        if args.generation:
            for m in modes:
                print(f"\n## Generation behaviour — {m}\n")
                print("| type | question | result | verdict |")
                print("|---|---|---|---|")
                for line in generation_report(m):
                    print(line)
    finally:
        if not args.keep:
            db.init_pool().close()
            _standalone(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
            print(f"\ndropped schema {SCHEMA}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    main()
