# HITL transcript review gate

**Date:** 2026-08-20
**Status:** accepted

## Context

The pipeline ran straight from transcription to indexing: `pipeline.process`
persisted the transcript and immediately chunked, embedded, and stored it. A
meeting became RAG knowledge the moment the models finished.

That makes AI output authoritative by default. STT mishears numbers and proper
nouns, and diarization mislabels speakers — the current build in particular
cannot reach pyannote at all and attributes every utterance to one speaker.
Whatever the models produced was answerable evidence, with no human in between.

## Decision

**An AI-generated transcript is a draft. It cannot become RAG knowledge until a
human explicitly reviews and approves it.**

- `pipeline.process` stops after transcript persistence and sets
  `REVIEW_REQUIRED`. It no longer chunks or embeds.
- `pipeline.index_transcript` performs chunking, embedding, and chunk
  persistence. Its only trigger is `POST /api/meetings/{id}/approve`.
- Indexing reads the transcript **from the database**
  (`pipeline.load_transcript`), never the in-memory draft the analysis phase
  produced. Reviewer corrections are therefore the source of the evidence.

### Status semantics

One new value. `INDEXING` already existed and already meant "chunking and
embedding are running", so it is reused unchanged for the approval phase.

```
UPLOADED → TRANSCRIBING → DIARIZING → REVIEW_REQUIRED
                                            │ approve
                                            ▼
                                        INDEXING → COMPLETED
```

`COMPLETED` now means *approved and indexed*. Failures during analysis still go
to `FAILED`.

### Indexing failure returns to the gate

An indexing failure sets `REVIEW_REQUIRED` with the error in `error_message`,
not `FAILED`. The transcript is untouched and still in the database, so the
meeting is genuinely retryable; sending it to `FAILED` would imply a dead end and
would need a separate recovery affordance in the UI. The reviewer sees the error
and the approve button is still there.

This is the approval path's fallback specifically. The re-embed added later
passes `on_failure='COMPLETED'`, because there the previous index still exists
and returning to the gate would make a searchable meeting unsearchable over a
failed no-op.

### Duplicate approval

The approve route performs an atomic compare-and-set:

```sql
UPDATE meetings SET status = 'INDEXING', error_message = NULL
 WHERE id = %s AND status = 'REVIEW_REQUIRED' RETURNING id
```

A second concurrent or repeated approval matches no row and returns `409`. This
is PostgreSQL doing the mutual exclusion; there is no lock manager, no queue,
and no application-level flag. `index_transcript` also deletes the meeting's
chunks before inserting, so any re-index replaces rather than appends.

### An approved transcript is immutable

Segment text, speaker assignment, **and speaker display names** are all editable
only at `REVIEW_REQUIRED`, enforced server-side.

`display_name` was the open question: it is presentation metadata, so treating it
as mutable after approval was tenable. It was rejected because `chunks.content`
renders display names at index time while `rag.search` resolves them at query
time. A rename after approval would leave the evidence text reading `화자 A: …`
under a source label reading `김팀장` — the provenance would contradict itself.
Uniform immutability also avoids a worse asymmetry: without a re-open route, a
reviewer could rename a speaker on an approved meeting but not fix a typo in the
very same sentence.

The rename route carries its status predicate inside the `UPDATE`, so it cannot
be raced by a concurrent approval.

### Edits cannot race an approval

`edit_transcript` opens with `SELECT status … FOR UPDATE`, holding the meeting
row for the transaction. Without it, `UPDATE meetings … WHERE status =
'REVIEW_REQUIRED'` could commit between the status check and the segment writes,
so an edit would land after approval and be excluded from the index while the
meeting reported `COMPLETED`. With the lock the two serialize in either order:
approve waits and then indexes the edit, or approve wins and the edit is refused
with `409`. PostgreSQL row locking, no lock service.

### Display names survive a redraft

Speakers are now upserted on `(meeting_id, speaker_code)` instead of being
deleted and recreated, so a reviewer's `display_name` survives a redraft. This
closes the known limitation recorded in `AGENTS.md` at governance time.

### Re-analysis

There is no re-analysis route — `pipeline.process` has exactly one caller,
`POST /api/meetings`, which always creates a new meeting. No policy for
"re-analysis during review" is needed, and none was invented. If a re-run
endpoint is ever added, the speaker upsert above already defines the naming
behaviour.

### Transcript versioning

None. `transcript_segments` is the single editable, current transcript. The
requirement is "no index before approval, index the current transcript after
approval" — that needs no history table, no snapshot, and no draft/approved
copies.

## Rejected

- **A separate `approval` service or module.** The logic is one function that
  reuses the existing chunker, embedder, and DB helpers. A module for one
  function is an abstraction with one implementation.
- **`APPROVING` as a distinct status.** `INDEXING` already carries that meaning.
- **`approved_at` / `reviewed_at` columns.** For meetings the current code
  indexes, `status = 'COMPLETED'` already encodes approval and no behaviour reads
  a timestamp. The one case a marker would disambiguate is legacy rows — see
  "Legacy rows" for why a column does not help there either. There is no
  authentication, so a `reviewer` column would store a fiction.
- **A `CHECK` constraint on `status`.** Only `set_status` and one compare-and-set
  write the column; a constraint would add migration complexity for a value set
  that two call sites already control.
- **A second serializer or source schema for reviewed evidence.**
  `serialize_sources` is unchanged; provenance is identical before and after.
- **A job/approval table, queue, or event log.** `meetings.status` remains the
  only progress state.

## Legacy rows

The gate is not retroactive. Meetings indexed before it existed reached
`COMPLETED` without approval, and retrieval keys on `COMPLETED`, so they stay
searchable. As of 2026-08-20 that is `id 1` and `id 2` of three rows in the
shared database — all synthetic demo audio, no real meeting content. `id 44` was
approved through the gate, but nothing in the schema distinguishes the two cases.

**No approval marker was added.** An `approved_at` column that retrieval ignores
is bookkeeping with no effect on the invariant; an `approved_at` that retrieval
*requires* would make legacy rows permanently invisible, because a `COMPLETED`
meeting cannot be moved back to the gate — turning a documented exception into
silently unreachable data plus a re-open feature nobody asked for.

**No row was modified either**, because the remediation is a data decision for
the owner, not a code change — and the current code already supports it with
nothing new. Setting a legacy meeting back to `REVIEW_REQUIRED` makes it
non-retrievable (status predicate), editable, and approvable (CAS), and its stale
chunks are deleted and rebuilt on approval:

```sql
-- operator action, not run by the application
UPDATE minutes.meetings SET status = 'REVIEW_REQUIRED' WHERE id IN (1, 2);
```

The honest statement of scope: **the invariant binds everything the current code
indexes; `COMPLETED` alone does not prove a human approved a row written by an
earlier version.**

## Consequences

- **Behaviour change:** an upload no longer becomes searchable on its own. Every
  meeting now requires a human action to enter the corpus.
- Retrieval gains `AND m.status = 'COMPLETED'` as defence in depth. The primary
  gate is structural — an unapproved meeting has no chunks — but the predicate
  also excludes a meeting whose chunks went stale when it returned to review.
- Meetings indexed before this change remain `COMPLETED` and retrievable; see
  "Legacy rows" above for the exact scope and the remediation.
- All editing — text, speaker assignment, display name — is restricted to
  `REVIEW_REQUIRED`. An approved transcript cannot currently be re-opened, since
  no route sets `COMPLETED` back to the gate. Deliberate: nothing has asked for
  it, and adding one would widen this change.
- No schema change. `status` is plain `TEXT`, so the new value needed no DDL.
