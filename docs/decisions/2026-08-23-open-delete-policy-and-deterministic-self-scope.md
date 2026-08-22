# A meeting is deletable at any status, and "내가 …" is judged deterministically

**Date:** 2026-08-23
**Status:** accepted

Two independent changes, both forced by the same UAT session, and both about the
same thing: a rule that made the application unusable in a state it can actually
reach.

## Context

**Deletion.** `DELETE /api/meetings/{id}` refused anything outside
`REVIEW_REQUIRED`, `COMPLETED`, `FAILED`, on the grounds that a background task
still held the audio. Background tasks are in-process `BackgroundTasks`. During
UAT the server ran out of memory and was restarted, and meetings were left at
`DIARIZING` with no task behind them — permanently, because the only way out was
a manual `UPDATE` against the shared database. AGENTS.md recorded that as an
accepted limitation ("an operator can move such a row to FAILED"); operating it
showed that an operator with a browser cannot.

**Self-scope.** `rag.plan` asked the planner LLM for `self_reference`, and a
`true` meant the question could only be answered from facts naming this
account's speaker — and, with no mapping, was refused with `rag.NO_IDENTITY`
("[나로 지정]을 먼저 눌러 주세요"). In UAT the general question
"이 통화에서 결정된 내용 정리해줘." was classified `true` and refused, then
answered normally when asked again. One nondeterministic bit was gating whether
the corpus was searched at all, and the same question produced two different
outcomes.

## Decision

**The delete policy is: any status, one endpoint, and the pipeline cooperates.**

- No status predicate in `DELETE /api/meetings/{id}`. Every screen (list row
  menu, meeting detail) calls it; the UI decides where to offer it, never what is
  allowed.
- Safety moved to the task side, where it belongs. Every write in `pipeline` and
  `intelligence` names the meeting by id, so a foreign key refuses it once the
  row is gone — the database was already the guard for row integrity.
- `pipeline.set_status` now returns whether the row still exists, and
  `pipeline.process` checks before persisting a transcript. When the meeting has
  gone it calls `_abandon`, which removes the audio it was holding — the one
  thing a foreign key cannot clean up, because `to_wav16k` may have written the
  normalized copy *after* the delete unlinked the pair.
- `index_transcript` makes the same check before its write, so a deliberate
  delete is not logged as an indexing failure.

**Whether a question is self-scoped is computed from the question, not asked.**

- `rag.is_self_scoped` matches explicit first-person surface forms
  (`rag.SELF_FORMS`) with a lookbehind, so 내용 / 안내 / 결제 are not first
  person. `self_reference` was removed from `PLAN_PROMPT` and from the planner's
  parsed output entirely; nothing reads the model's opinion of it.
- The protection for real self-scoped questions is unchanged: an explicit
  "내가 요청한 게 뭐야?" without a mapping still returns `NO_IDENTITY`, and still
  searches facts only.

## Rejected

- **Celery / Redis / a job table, so a task could be cancelled or resumed.** The
  problem was a row nobody could remove, not a task nobody could cancel. A queue
  is a durability decision with an operational cost, and the boundary in CLAUDE.md
  says it needs a real durability requirement, not a stuck row.
- **Cooperative cancellation** (a flag the pipeline polls, aborting STT mid-run).
  It would save some GPU time on a delete and buys nothing else; the task
  already lands on a row that no longer exists. Not worth the concurrency
  surface today.
- **A force-delete flag or an admin-only route.** Two delete policies to
  document, test, and keep in sync, for a case the normal one now handles.
- **A "stale processing" detector** (a heartbeat column, or a sweeper that moves
  old `DIARIZING` rows to `FAILED`). It infers what only the operator knows, and
  a wrong inference would mark a genuinely running analysis as failed.
- **Keeping the LLM's `self_reference` and AND-ing it with the deterministic
  check.** It fixes the false positive and keeps the false negative: an explicit
  "내가 …" question would still occasionally be treated as general. Reading only
  the question makes both directions stable.
- **Refusing on a wider set of pronouns** ("우리", "본인"). Neither names the
  asker unambiguously, and a false positive here is exactly the bug being fixed.
  They fall through to a general search, which answers rather than refuses.

## Consequences

- Easy: a stuck meeting is removable from the UI, at any status, by the same
  click that removes a finished one.
- Easy: a general question is never refused for a missing speaker mapping, and
  repeating a question cannot change that.
- Harder / accepted: deleting a meeting mid-analysis leaves a running STT or
  diarization doing work that will be thrown away. `_abandon` cleans the audio in
  the common path; a delete that lands exactly while ffmpeg is writing may leave
  the normalized WAV, which the next check would not see.
- Accepted ceiling: a self-scoped question phrased without a listed first-person
  form ("본인이 맡은 일") is treated as a general question — it is answered, with
  no speaker filter, rather than refused.
- Invalidated: the AGENTS.md invariant "a meeting stuck mid-processing cannot be
  deleted", and the `409` expectation in
  `tests/test_hitl.py::test_delete_is_refused_while_a_background_task_runs`,
  which became `test_delete_is_allowed_at_every_status` plus a deliberate
  delete-during-`process` race test. No stored data was invalidated.
- Retrieval measurement: unaffected by construction. `scripts/evaluate` skips
  `rag.plan` for its retrieval metrics, and no question in the evaluation set is
  self-scoped, so the change cannot move a number there.
