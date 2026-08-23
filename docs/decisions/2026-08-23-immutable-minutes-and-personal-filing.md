# Immutable approved minutes, and filing that belongs to a person

**Date:** 2026-08-23
**Status:** accepted
**Migration:** `011_personal_organization`
**Supersedes the versioning half of:**
[2026-08-23-meeting-ownership-sharing-and-versioning.md](2026-08-23-meeting-ownership-sharing-and-versioning.md)

## Context

Two things came out of the human UAT, and they turn out to be the same shape of
mistake: the product was treating something *one person decided* as if it were a
property of the recording.

**Revisions.** The previous wave built a full revision workflow — `회의록 수정`
starts a v2, the published v1 keeps answering until v2 finishes indexing, an
atomic swap, a version history. It works, and the UAT concluded the product does
not want it. A set of approved minutes is a record of what was said; correcting
it after the fact means every stored citation, every chunk, every fact, and
every answer another account was already given now quotes words that have moved.
The value of a transcript is that it does not.

**Filing.** `meetings.category_id` made the category a column on the meeting, so
the owner's "업무 / 구매부" arrived on a shared reader's screen as if it were a
fact about the recording — and that reader had no folder of their own to put it
in, and no way to call it what it is to *them* ("면접 답변용 정산 프로세스 사례").
One global `meeting_categories` tree meant every account also saw every folder
name anybody had invented, which for a category named after a customer is a leak
in its own right.

## Decision

### One editing window, closed by the server

```
업로드 → STT → 화자 분리 → REVIEW_REQUIRED → [사람이 수정] → 승인 → COMPLETED
                                                                      └─ 이후 수정 불가
```

`app/api/meetings.py:_editable_draft` returns a version only for a `DRAFT` on a
meeting whose status is `REVIEW_REQUIRED`. It is the single gate in front of the
transcript PATCH, the speaker rename, the AI correction suggestions, and the
approval, so all four refuse an approved meeting with one condition in one place.
`POST` and `DELETE` on `/api/meetings/{id}/versions` are gone, and
`versions.create_draft` / `discard` with them: the action does not exist, so it
answers `405` rather than `403`.

Hiding the buttons was never the point — `tests/test_versions.py` drives the API
directly, and `tests/test_ownership.py` still parametrizes every endpoint.

**Rejected: keeping the revision workflow and only hiding the UI.** Dead code
that a request can still reach is worse than either having the feature or not.
The refusal has to be the boundary.

**Rejected: dropping `meeting_versions` and the `version` columns.** A deployed
database may already hold a v2 that a stored citation rests on, and migrations
here only add. The tables stay, read-only: `GET /versions` and `?version=` still
resolve, the meeting reports no editable revision, and a stranded `DRAFT` from
that build cannot be resumed or approved (both are tested).

**The cost, stated rather than worked around:** a transcript found to be wrong
after approval can only be replaced by uploading the audio again. That is the
price of every citation resting on words that do not move, and it is in
`AGENTS.md` under "Known limitations".

What is *kept* from the previous design is the part that was never about
revisions: embedding happens before the transaction that deletes the old chunks,
inserts the new ones, and publishes the version together. A failure leaves the
meeting at the review gate with nothing half-written.

### A meeting is canonical; how you file it is yours

Migration 011 splits the two apart:

```
        meetings                          user_meeting_filing
        ────────                          ───────────────────
owner ─► title, held_at, transcript,   ◄── (owner,  meeting)  category, alias
        speakers, status, provenance   ◄── (reader, meeting)  category, alias
reader ─ read ─►                           one row each, invisible to the other
```

- `user_categories` — one tree per account. `UNIQUE (user_id, name)`: two people
  may both have a 업무 and neither may have two.
- `user_meeting_filing` — `(user_id, meeting_id)` PK, carrying that account's
  `category_id` and `alias`. A row with both NULL means the same as no row.
- `chat_sessions.category_id` — the same tree, as a column, because a
  conversation is already owned by one account.

`display_title` is `coalesce(alias, title)`, resolved per request.
`meetings.title` never changes, and clearing an alias returns to it rather than
storing a copy — so an owner renaming the recording still reaches everyone who
never chose a name of their own.

**`PUT /category` and `PUT /alias` take read access, not ownership.** That is the
whole distinction: a shared reader arranging their own list is not editing
somebody's minutes, and the owner's screen does not move. Everything canonical
stays owner-only exactly as it was.

**Organisation is never permission.** `organization.FILING` is a LEFT JOIN and
nothing more — a filing row is not a reason to show a meeting, and its absence is
not a reason to hide one. After a revoke the reader's filing survives (it is
theirs), the folder counts zero, and every door still answers `404`.
`access.READABLE` remains the only thing that decides.

**Cross-account filing is refused by the database.** Every reference to a
category is a *composite* foreign key carrying `user_id`
(`user_categories.parent_id`, `user_meeting_filing.category_id`,
`chat_sessions.category_id`), so a filing cannot name somebody else's folder even
if the application forgot to check — the same trick `meeting_user_speakers`
already used for speakers.

**Rejected: `ON DELETE SET NULL` on the composite category references.** Setting
a composite key to NULL would null `user_id` too; the column-list form is
PostgreSQL 15+, and this repository targets an instance whose version it does not
control. `RESTRICT` plus clearing the filings inside the delete transaction is
two extra statements and works everywhere — and it is also what keeps an alias
alive when the folder beside it is removed.

**Rejected: adding `user_id` to `meeting_categories`.** The `UNIQUE (name)` from
migration 006 would have to become `UNIQUE (user_id, name)`, which means dropping
a live constraint. Migrations here only add.

**Rejected: deleting `meeting_categories` and `meetings.category_id`.** Same
rule. The backfill reads them, and a deployed database may still need it. They
are documented as legacy, unread, and never written.

**Backfill.** `meetings.category_id` says how the *owner* filed their own
meeting, so it becomes that owner's personal filing — ancestors included, so the
hierarchy survives rather than flattening. It says nothing about how anybody else
would file it, so no other account gets a row, and a meeting with no proven owner
is skipped. Names are the join key because migration 006 made them globally
unique, which makes the mapping exact.

### Where these things live on screen

Three placements followed from the model rather than from taste, and each
removed a route:

- **Category CRUD moved into the sidebar tree.** Managing categories was a
  `/categories` page, which meant leaving the list in order to organise the list.
  Filing is an everyday act; it belongs where the folders are. Expanding a
  category also lists a few recent meetings and then 전체 보기 — a sidebar that
  renders every meeting stops being navigable exactly when it is needed.
- **An invitation became a notification.** `/invitations` put a destination in
  the navigation that is empty almost all of the time. It is now a count in the
  sidebar and a dialog over whatever screen the reader was on — the app's one
  modal, because there is no popover primitive and below `md` the sidebar is a
  top bar with nothing to anchor to.
- **The version panel is gone**, along with `/categories` and `/invitations`.
  Dead UI for a workflow that no longer exists.

### Two smaller corrections, both about honesty

- **The 출처 count is what the answer cited.** Retrieval returns a fixed number
  of candidates and the model quotes the ones it used, so "출처 6개" on an answer
  resting on two described the search rather than the answer. The button now
  counts the `[N]` markers in the text (and says 검색 결과 N개 when there are
  none). Every candidate is still in the payload, in storage, and in the drawer,
  which states how many were not quoted — showing fewer is a presentation choice,
  returning or storing fewer is forbidden.
- **The 출처 drawer is genuinely off-canvas.** Always mounted, moved by
  `translate-x`, overlaying the conversation rather than pushing it, `inert` and
  `aria-hidden` while closed. Conditional rendering made the chat column jump its
  full width in a single frame. The trigger is a toggle, a `[N]` opens it focused
  on that card, and ESC closes it.
- **An answer is prose, not a card.** A short reply used to sit in a full-width
  bordered surface that made two lines look like a panel. The question keeps its
  compact bubble, because it is a short thing somebody typed; the answer is the
  page's content and needs no container.

## Consequences

- `app/services/organization.py` is a new module and the only place the personal
  layer is expressed. A screen that wants a meeting's display title or folder
  reads `organization.COLUMNS`; a query that filters by category pastes
  `organization.SUBTREE`. A second way to do either is a defect.
- Retrieval semantics are unchanged. Dense, lexical, RRF, metadata boost, fact
  retrieval, temporal ordering, conflict detection, and citation validation are
  exactly as they were; no evaluation number moves, because the candidate set did
  not change. Stored evidence is retitled on read, which touches no SQL in
  `rag.py` or `intelligence.py`.
- The category API kept its path (`/api/meeting-categories`) and its shape, and
  became per-account underneath. Its 404/400 split is now the ordinary one: the
  category in the path is a 404 when it is not yours, a category named in a body
  is a 400.
- `PUT /api/meetings/{id}/category` changed from owner-only to read-access, and
  now writes a filing rather than the meeting. That is a deliberate contract
  change and `tests/test_sharing.py` records it.
