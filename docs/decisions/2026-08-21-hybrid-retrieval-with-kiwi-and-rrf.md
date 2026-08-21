# Hybrid retrieval: Kiwi lexemes in PostgreSQL FTS, fused with dense by RRF

**Date:** 2026-08-21
**Status:** accepted

## Context

Retrieval was dense only: BGE-M3 into `pgvector`, cosine, Top-K 6 per layer. It
had never been measured, so "improve retrieval" had no baseline to improve on.

An evaluation set was built first (`scripts/eval_data.py`, `scripts/evaluate.py`):
9 meetings — 6 authored, 3 copied verbatim from meetings 1, 2 and 525 of the real
database — 83 utterances, 24 facts, 44 questions across 13 question types, with
the answering meeting and the answering *utterance ids* written down for each.
Metrics are computed against real BGE-M3 vectors and real Kiwi lexemes in a
throwaway `minutes_eval` schema; a stubbed embedding would have measured the stub.

Dense-only baseline, over the 41 questions that have an answer:

| | hit@1 | hit@3 | hit@5 | MRR | meeting@5 |
|---|---|---|---|---|---|
| dense | 0.854 | 0.927 | 0.927 | 0.896 | 0.927 |

One question type failed outright. `action_item` ("해야 할 일이 뭐야?", "남은
작업이 뭐야?") scored **hit@3 0.000, MRR 0.121** — the correct fact ranked 7th and
10th. The question shares no content word with any answer, and BGE-M3 puts every
commitment-shaped sentence at a similar distance from it. Cosine similarity had
nothing left to separate them with.

## Decision

Two retrieval axes per layer, fused by rank.

```
Approved transcript
      -> chunking (unchanged)
      -> BGE-M3 1024-d -> pgvector  (dense, unchanged)
      -> Kiwi morphemes -> tsvector -> GIN  (lexical, new)
      -> RRF over the two rankings
      -> metadata agreement
      -> Top-K 6 per layer, as before
```

* **Kiwi** (`kiwipiepy`) cuts 조사 and 어미 off and keeps nouns, foreign words,
  numbers, Hanja and verb/adjective stems (`app/services/lexical.py`). Korean is
  agglutinative: a raw `to_tsvector` indexes 인증서를 and 인증서가 as two words and
  matches neither against 인증서.
* **PostgreSQL FTS.** `chunks.lexemes` and `meeting_facts.lexemes` hold the
  morpheme string; `lexeme_tsv` is a `GENERATED ALWAYS` `tsvector` over it with a
  GIN index (migration 007). Generated, so the vector cannot drift from the string
  it came from and no application code can write it.
* **RRF**, `1/(60 + rank)`, summed over the two axes. Not a weighted sum of the
  scores: a cosine similarity and a `ts_rank_cd` are not on the same scale and no
  constant makes them comparable. RRF reads only positions, which are.
* **Metadata agreement** as an additive term worth `1/(RRF_K+1)` per signal —
  one first place in one axis — for a speaker whose full stored name was typed, a
  meeting at least half of whose title was named, or the month *and* day a meeting
  was actually held. It never removes a candidate. The chat scope stays the only
  hard filter, applied in SQL on all four retrieval paths.

Result on the same evaluation set:

| mode | hit@1 | hit@3 | hit@5 | MRR | meeting@5 | ms |
|---|---|---|---|---|---|---|
| dense (before) | 0.854 | 0.927 | 0.927 | 0.896 | 0.927 | 230 |
| lexical only | 0.756 | 0.927 | 0.951 | 0.848 | 0.951 | 60 |
| hybrid | 0.805 | 0.976 | 1.000 | 0.891 | 1.000 | 308 |
| **hybrid+meta (after)** | **0.829** | **1.000** | **1.000** | **0.911** | **1.000** | 285 |

`action_item` went from hit@3 0.000 / MRR 0.121 to 1.000 / 0.750, and `metadata`
questions from MRR 0.619 to 0.833. hit@1 fell 0.854 → 0.829: on four questions the
right answer moved from rank 1 to rank 2 or 3, which is the ordinary RRF trade —
top-1 sharpness for recall — and it is accepted here because every retrieved
source reaches the model anyway, while a rank of 7 or 10 does not survive a Top-K
of 6.

## Rejected

**OpenSearch / Elasticsearch.** `tsvector` + GIN is the same inverted index those
are built on, it is already in this database, and the corpus is one
organisation's meetings. A second datastore would also make the scope predicate
exist in two languages, which is the invariant most likely to be broken.

**A weighted score sum** (`0.7*dense + 0.3*lexical`). The two scores have
different ranges and different distributions, so any constant is a guess that
looks like a parameter.

**A cross-encoder reranker.** The server is CPU-only and already loads Whisper,
pyannote and BGE-M3. With hit@5 at 1.000 there is nothing left for a reranker to
find on this corpus. Revisit when a corpus large enough to leave hit@5 below 1.0
shows dense+lexical+metadata is not enough.

**A graph database for "when did this change".** Two facts, both stored, both
carrying their meeting's `held_at`, ordered by it. That is the query. A
`supersedes` edge would be a second, derivable source of truth.

**Tuning `RRF_K`.** Swept at 10 / 20 / 60 / 120: identical on every metric. The
literature default is kept, and the sweep is why, rather than taste.

**Lowering `CANDIDATES`.** Swept at 6 / 10 / 20 / 30 / 40: 6 loses hit@3 0.024,
and everything from 10 up is identical. 30 is kept because this corpus is far
smaller than a real one and the cost is in a `LIMIT`, not in the embedding call
that dominates the 285 ms.

**Changing the chunking constants.** Measured before touching them
(`--chunking`): 24 of 24 facts have all of their evidence inside a single chunk,
overlap costs 1.19 segment copies per segment, and `MAX_UTTERANCES = 7` — not the
token budget — is what actually closes a chunk on real transcripts, whose
utterances average ~18 characters. The failure mode a bigger or smaller chunk
would fix does not occur, so nothing was changed.

**Adding 회의 / 미팅 / 얘기 / 내용 to the lexical stopwords.** They carry no IDF in
a meeting corpus, which is a good argument and the wrong conclusion: it cost
hit@3 0.024 and gained nothing, because `TITLE_MATCH` already stops one shared
title word from reading as naming a meeting. Recorded in
`lexical.py` beside the stopword set so it is not re-tried by intuition.

**A no-answer score threshold.** Fusion makes one available — a question with no
answer scores ~0.016 (one axis, rank 1, no agreement) against ~0.033 for one with
an answer — but the generation-level metric that would justify a cut-off could not
be measured: the configured `OPENAI_API_KEY` returns 401 `invalid_organization`,
so no-answer accuracy is unmeasured, not zero. Guessing a threshold from four
observations is exactly what this record exists to avoid.

## Consequences

**Easy.** An exact term — a port number, an acronym, a person's name, an amount —
is now findable by the words that were said, not only by what they resemble. A
question naming a meeting or a date reaches that meeting. `mode="dense"` keeps the
baseline runnable, so the next change has something to be compared against.

**Hard.** `ts_rank_cd` has no IDF, so a term that appears in every chunk cannot be
down-weighted at query time; the mitigation is a small stopword set applied at
index time, marked `ponytail:` in `rag.search_lexical`. Retrieval latency rose
from ~230 ms to ~285 ms per question, dominated by the two embedding calls, not by
Kiwi (0.2 ms) or by FTS (34 ms).

**Invalidated.** Nothing vectorised. Existing embeddings are untouched and are
*not* regenerated: `python -m scripts.backfill_lexemes` writes only the lexeme
column, and re-embedding stays a separate, more expensive operation.
`chunks.source_segment_ids` is left NULL on rows indexed before 007 rather than
guessed; re-indexing a meeting fills it.

**Payload semantics changed.** A source's `score` is now the fused ranking score
in the active mode's units, not always a cosine similarity. It is stored in
`chat_messages.sources` and is not shown anywhere in the UI.

**New dependency.** `kiwipiepy` 0.23.2 + `kiwipiepy_model` 0.23.0, LGPL v3, ~106 MB
in the image, model shipped in the wheel so nothing is downloaded at runtime.
