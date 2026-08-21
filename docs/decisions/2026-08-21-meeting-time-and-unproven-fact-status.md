# When a meeting happened, and what an unproven status is called

**Date:** 2026-08-21
**Status:** accepted
**Supersedes parts of:**
[2026-08-21-meeting-intelligence-in-postgresql.md](2026-08-21-meeting-intelligence-in-postgresql.md)

## Context

The Meeting Intelligence wave shipped three things that each treated a value the
system happened to have as a value somebody had actually stated.

**`created_at` stood in for the meeting's date.** Cross-meeting ordering sorted
`DECISION` facts by it, and relative deadlines resolved against it. It is the
moment the audio was uploaded. For a recording uploaded the same afternoon the
two coincide; for a backlog import of six months of recordings they do not, and
"이 결정이 어떻게 바뀌었어?" would then answer in upload order — which can be
exactly backwards. The limitation was written down in `README.md` and `AGENTS.md`
at the time, which is not the same as being safe.

**A bare `M월 D일` was rolled forward a year when it had already passed.** A
meeting held 2026-08-21 that said "8월 10일까지" produced `deadline_at =
2027-08-10`: a deadline a year away from anything anybody said. The rule was
written to be helpful and instead invented the single most consequential field
on the fact.

**`OPEN` was both a claim and a default.** Any status the extraction did not
state became `OPEN`, and `OPEN` was the column default. So "지난달 내가 요청한
것 중 아직 안 끝난 건 뭐야?" collected facts nobody had ever said were
outstanding, and the evidence handed to the model asserted they were.

## Decision

**1. `meetings.held_at TIMESTAMPTZ NULL` is when the meeting took place.**
`created_at` keeps its only real meaning: when the row was created. Anything
that means "when this happened" reads `coalesce(held_at, created_at)` — the
chronological re-sort in `intelligence.search` and the base date in
`intelligence.build`.

The fallback is deterministic, and it is labelled. `search` returns
`meeting_at_known`, and every rendering of a fallback date — the evidence block
the model reads, the source card in the chat — carries `등록`. The system may
sort by a date nobody entered; it may not claim it is when the meeting happened.

`held_at` is set through `PUT /api/meetings/{id}/held-at` and edited on the
meeting detail page with a native `<input type="datetime-local">`. It is
editable at any status, including after approval: this is metadata about the
meeting, not a word of the approved transcript, so the immutability gate does
not apply to it. Deadlines already extracted keep the date they resolved to
until the facts are rebuilt, and the UI says so next to the field.

**2. `deadline_at` is filled only when the year, month, and day are all pinned.**
That leaves `오늘/내일/모레` and weekday forms, which are relative to the day the
meeting was held and have one reading, and year-bearing forms `YYYY-MM-DD` and
`YYYY년 M월 D일`. A bare `M월 D일` no longer resolves at all.

**3. `UNKNOWN` is a status, and it is the default.** `meeting_facts.status` is
`UNKNOWN | OPEN | DONE | CANCELLED | DEFERRED`, defaulting to `UNKNOWN` in the
column. `OPEN` becomes what it should always have been: a claim that the meeting
said something is still outstanding. There is **no per-type default** — an
`ACTION_ITEM` with no stated status is `UNKNOWN` like everything else.

The generator is told that a `미확인` item is neither finished nor outstanding,
and the rendered evidence says `상태: 미확인(회의에서 완료 여부가 언급되지
않음)` rather than a bare enum.

## Alternatives rejected

**Keep `created_at` and document the caveat.** It was already documented. A
caveat in a README does not stop the ordering from being wrong, and the answer
gives no sign that the timeline it presents is an upload order.

**Infer `held_at` from the audio file's mtime or its filename.** A guess dressed
as a record. The same class of mistake as the one being fixed, and it would be
harder to see because the value would look entered.

**Backfill `held_at = created_at` for existing meetings.** It would erase the
distinction the column exists to make. NULL is the truth: nobody has said when
those meetings were held.

**Require `held_at` at upload.** It would block a bulk import behind a form
field and make the common case — recorded and uploaded the same day — worse for
no gain. NULL plus a labelled fallback covers it.

**Resolve a bare `M월 D일` to the meeting's own year when it is not in the past.**
Tempting, and it is how a person reads "9월 1일까지" in an August meeting. It is
still an inferred year, and inferring the year is what produced the 2027 bug.
The consequence is accepted: `9월 1일까지` now stores `deadline_text` and a NULL
`deadline_at`. The text reaches both the reader and the model, so nothing is
lost from the answer — only the sortable date, which nothing currently sorts on.
Revisit if a real query needs to filter facts by date.

**Let the model return `deadline_at`.** Never. The model repeats the words that
were said; Python turns them into a date or refuses to.

**Give `ACTION_ITEM` a default of `OPEN`.** Defensible — an action item is by
definition something still to do at the moment it is agreed. Rejected because it
reintroduces the ambiguity one type at a time: a query for what is unfinished
could no longer distinguish "the meeting said this is outstanding" from "this
was recorded as an action item and never mentioned again". One rule for every
type is smaller, and `UNKNOWN` loses no information — an `ACTION_ITEM` with
`UNKNOWN` status is still an action item.

**A `fact_status_history` table.** Nothing needs a status timeline yet. A fact's
status is what the meeting it came from said; a later meeting produces a later
fact, and the chronological ordering already puts the two side by side.

## Consequences

- Migration `005_meeting_held_at.sql`. It adds `meetings.held_at` and widens the
  `meeting_facts.status` CHECK. Widening is the one place a `DROP CONSTRAINT`
  appears in this repository: the constraint is re-added immediately, accepting
  a superset, so no existing row can fail it and no data is touched.
- Existing facts keep `status = 'OPEN'`. They were extracted under the old rule
  and so most of them mean `UNKNOWN`; rebuilding a meeting's intelligence
  re-derives them. Nothing rewrites them automatically — guessing which stored
  `OPEN` was a real claim is the same mistake again.
- `deadline_at` gets sparser. `deadline_text` is unchanged and is what the UI
  and the evidence show first.
- `meetings.created_at` is now only a registration timestamp. Any new code that
  wants "when the meeting happened" must use `coalesce(held_at, created_at)` and
  must label the fallback.
