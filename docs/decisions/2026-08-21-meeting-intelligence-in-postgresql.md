# Meeting Intelligence as structured rows in PostgreSQL, not a graph database

**Date:** 2026-08-21
**Status:** accepted

## Context

`chunks` answers "what was said". It cannot answer "who asked whom to do what,
by when" — those relationships exist in the transcript text but nowhere in the
schema, so a question like "누가 맡았지?" was a dense-similarity guess and
"내가 요청한 게 뭐야?" had no anchor at all: the logged-in account and the
diarized `SPEAKER_00` label are unrelated identifiers.

Seven questions had to actually work: 내가 요청한 것 / 누가 요청했는지 / 누가
맡았는지 / 기한 / 결정 시점 / 회의 간 결정 변화 / 지난달 요청 중 미완료.

The obvious framing for that is a knowledge graph, and the obvious tool is a
graph database. This repository already runs PostgreSQL with pgvector and has a
standing boundary against new infrastructure.

## Decision

Four additions to the `minutes` schema (`004_meeting_intelligence.sql`) and one
new service module. No new dependency of any kind.

- `meeting_facts` — one row per REQUEST / DECISION / ACTION_ITEM, with
  `content`, `status`, `deadline_text` / `deadline_at`, the time range,
  `source_segment_ids`, `source_text`, and a `vector(1024)` embedding from the
  same BGE-M3 model.
- `meeting_fact_participants` — `(fact_id, speaker_id, role)` where role is
  REQUESTER / ASSIGNEE / DECIDER. This is the relationship layer: three roles
  and one join, not an ontology.
- `meeting_user_speakers` — the logged-in user's speaker, per meeting. This is
  what makes "내가" mean something.
- `meetings.intelligence_state` / `intelligence_error` — extraction state, kept
  out of `meetings.status`.

Retrieval runs both layers over the same scope and merges the evidence, facts
first and in chronological order. `rag.plan` resolves a follow-up into a
standalone query and names the fact filters in one JSON call.

**Provenance is enforced by the database.** `source_segment_ids` is
`CHECK (cardinality(...) > 0)`, so a fact with no transcript behind it cannot be
stored, and `source_text` travels with it into every answer.

**Identity is enforced by the database.** `meeting_user_speakers` has a
composite foreign key to `speakers (id, meeting_id)`, so a speaker from another
meeting cannot be claimed; `PRIMARY KEY (meeting_id, user_id)` and
`UNIQUE (meeting_id, speaker_id)` make the mapping one-to-one within a meeting.

**The model proposes; `_validate` and SQL decide.** A segment id this meeting
does not have is dropped and a fact with no source left is dropped with it. A
speaker that is not this meeting's loses the role, not the fact — it was still
said. `deadline_at` is computed in Python from the meeting date, never by the
model. An unrecognized `status` becomes `OPEN`.

> Superseded the same day by
> [2026-08-21-meeting-time-and-unproven-fact-status.md](2026-08-21-meeting-time-and-unproven-fact-status.md):
> the meeting date is now `coalesce(held_at, created_at)`, a bare `M월 D일` no
> longer resolves, and an unstated status is `UNKNOWN` rather than `OPEN`.

## Rejected

- **Neo4j, or any graph database.** The traversals this product needs are one
  hop: fact → participant → speaker → user. That is a join. A second datastore
  would double the deployment, the backup story, and the consistency problem to
  express a relationship a foreign key already expresses. Revisit only against
  the evidence listed under Consequences.
- **Microsoft GraphRAG.** Community detection and entity graphs over a corpus
  of a few dozen meetings would cost more per index than the retrieval is worth,
  and its output is not something a reviewer can trace to a timestamp.
- **A `SUPERSEDES` / `UPDATES` edge table.** "결정이 어떻게 바뀌었어?" is
  answered by retrieving the DECISION facts and sorting by meeting date. An edge
  table would need its own inference step, its own failure mode, and its own
  review, to encode an ordering the meeting dates already carry. Build it when a
  query genuinely cannot be expressed as "these facts, in this order".
- **An `event_time` column on a fact.** Derivable from the meeting's date and
  the fact's `start_time`. A third timestamp is a copy that can disagree. (That
  date became `coalesce(held_at, created_at)` in the record above; the reasoning
  for not copying it onto the fact is unchanged.)
- **A generic entity/relation ontology.** Three fact types and three roles cover
  every question that was asked. OWNER was folded into ASSIGNEE: "담당" and
  "맡은 사람" are the same person, and two names for it would only produce
  inconsistent extraction.
- **A separate `meeting_intelligence` state table.** Two columns on `meetings`
  cascade with the meeting for free and need no orphan handling. They are still
  separate from `meetings.status`, which was the actual requirement.
- **Putting extraction state in `meetings.status`.** A failed extraction would
  make an approved, indexed, searchable meeting look broken. The two lifecycles
  are independent and are stored independently.
- **Extraction inside `index_transcript`.** It would put an LLM failure on the
  approval path and make `pipeline` import `intelligence`, which imports
  `pipeline`. It is a second background task instead, queued after the first, so
  it only ever sees a meeting that reached `COMPLETED`.
- **Rebuilding facts on re-embed.** A re-embed exists to be cheap — no audio, no
  models beyond the embedder. Adding an OpenAI request per window to it would
  change what the button means.
- **A second transcript reader.** `pipeline.load_transcript` was extended with
  the row ids instead. Two readers of an approved transcript is two definitions
  of what the approved transcript is.
- **A separate query-planner and query-rewriter call.** One JSON call returns
  both. Three OpenAI requests per question was not worth two fields.
- **A query planner that can fail closed.** Any planner failure falls back to
  the question as typed with no filters — exactly the dense retrieval this had
  before. A planner outage must degrade the answer, not remove it.
- **Widening the scope for a structured question.** Fact retrieval takes the
  same `meeting_ids` and applies the same predicate. A relationship question is
  not a reason to look at a meeting the user excluded.
- **Guessing an unmapped "내가".** Without a `meeting_user_speakers` row the
  answer says so and returns nothing. Picking the most likely speaker would be
  the single most damaging thing this feature could do.

## Consequences

Easy: a new relationship is a role value; a new fact kind is an enum value and a
prompt line. Scope, provenance, and approval rules did not have to be restated —
the new layer reuses them. No new service to deploy, back up, or keep consistent.

Hard: facts are only as good as one extraction pass, and a missed request is
invisible. Status is never inferred, so "아직 안 끝난 것" means "nothing said
otherwise". Deadline normalization covers a handful of Korean forms. Every approval now costs one
OpenAI request per 40-segment window, with no ceiling, and every question costs
one planning request.

Invalidates nothing. `004` only adds; `chunks` and every existing embedding are
untouched, and removing the fact layer would leave the dense RAG exactly as it
was.

**Revisit a graph database when — and only when — one of these is observed**, in
this repository, with a query that motivated it:

- traversals of three or more hops that SQL expresses only with recursive CTEs
- relationship kinds growing past what a single `role` enum can hold
- a cross-meeting entity graph becoming a product surface in its own right,
  rather than a way to answer a question
- traversal cost that vector + relational queries measurably cannot meet
- a graph-native query demonstrating better accuracy on the same evaluation set

Until then this stays where it is.
