# minutes — repository invariants

What is true of `minutes`, and what must remain true.

This file holds invariants. `CLAUDE.md` holds workflow. Nothing in `CLAUDE.md`
or in any tool's default behaviour overrides this file.

---

## MAIN RULE

The highest-priority development principle in this repository. It applies before
Ponytail, before GSD, before anything in `CLAUDE.md`. When another rule conflicts
with this section, this section wins.

### Think Before Coding

- Do not start with code.
- State your assumptions explicitly.
- Do not silently resolve an ambiguous requirement in one direction. If two
  readings produce materially different work, surface the difference.
- If a simpler approach exists, say so before building the complex one.
- If something important is not understood, stop and confirm.
- Never edit from a guess. Trace the real call path first — `app/main.py`
  registers the routers, the routers call `app/services/`, and every DB access
  goes through `app/db.py`. Follow it.

### Simplicity First

- Write the minimum code that satisfies the requirement.
- Do not build for a future requirement that was not asked for.
- Do not add an abstraction for something used once.
- Do not add configurability or flexibility that nothing needs.
- Do not add a dependency, framework, or layer for convenience or taste.
- If a few lines of existing code solve it, do not build a new system.
- If 200 lines can clearly be 50, reconsider.

### Surgical Changes

- Change only the files and lines the task needs.
- Do not tidy adjacent unrelated code "while you're in there".
- No unrequested rename, reformat, or refactor.
- Follow the existing style and patterns of this repository.
- Before changing a shared function, find every caller. `app/db.py:conn`,
  `app/services/embedding.py:encode`, and `app/services/rag.py:search` all have
  more than one caller.
- Clean up imports, variables, and functions that *your* change made unused.
- Never damage the user's uncommitted work.

### Goal-Driven Execution

- Turn the task into a verifiable goal before implementing it.
- For multi-step work, decide each step *and its verification* up front.
- "I wrote the code" is not a completion condition.
- Confirm the result with test, build, or runtime evidence.
- On failure, find the cause and verify again.
- Never report a partial run as a full pass. See "Verification invariant".

### MAIN RULE and Ponytail

```
MAIN RULE   → how an agent thinks and acts
Ponytail    → how that turns into the smallest working implementation
```

They are one principle at two levels, not two competing rule sets. Ponytail is
the implementation posture; details live in `CLAUDE.md`. Where they conflict,
the MAIN RULE wins.

---

## Product boundary

`minutes` turns a meeting recording into searchable, attributable evidence:

```
audio upload → transcription → speaker separation
             → speaker/timestamp transcript
             → utterance chunks + embeddings
             → question answering with cited evidence
```

It is not a general transcription service, not a meeting scheduler, and not a
note-taking editor.

It has a POC login. That login exists to separate one person's chat history from
another's — nothing more. There are no roles, no teams, no meeting ownership, and
no per-meeting permission: every logged-in user sees every meeting.

## Architecture boundary

- A single FastAPI process serves the built frontend, the JSON API, and runs
  the analysis pipeline. There is no separate worker process and no second
  container.
- Analysis runs on `fastapi.BackgroundTasks`, in-process.
- Database access is raw SQL through psycopg 3. There is no ORM and no
  repository/DAO layer.
- The frontend is a React + TypeScript single-page app in `frontend/`, built by
  Vite. **Node exists only at build time**: the Dockerfile's first stage runs
  `npm ci && npm run build`, and the runtime image receives `frontend/dist` and
  nothing else — no node, no npm, no node_modules, no frontend source.
- There is one repository, one image, one container, one port, one origin. A
  separate frontend service, a Node server, an extra nginx, or a second
  repository would each break that and is out of bounds.
- Authentication is one `require_login` middleware in `app/main.py`. There is no
  auth framework, no dependency-injection guard per route, and no token library.
- PostgreSQL is external and pre-existing. This repository never runs a database
  container.

Detail: [docs/architecture/current.md](docs/architecture/current.md).

## Audio pipeline invariant

- Every input is normalized to 16 kHz mono WAV by FFmpeg before any model sees
  it (`app/services/audio.py`). Both faster-whisper and pyannote consume that
  one file.
- Accepted extensions are exactly `config.ALLOWED_EXT`:
  `.wav .mp3 .m4a .flac .ogg .webm .mp4`. The check is extension-based and
  happens before the file is written.
- The FFmpeg binary is resolved at call time: system `ffmpeg` if present,
  otherwise the `imageio-ffmpeg` static build. Do not hardcode a path.
- Uploaded files are stored under a generated UUID name; the original filename
  is kept only as a database column.

## Transcript invariant

- STT and diarization are independent passes over the same WAV. Neither depends
  on the other's output.
- They are joined by time overlap in `app/services/transcript.py`. Each STT
  segment is assigned the single speaker it overlaps most.
- Speaker identity is positional and anonymous: `SPEAKER_00`, `SPEAKER_01`, …
  Real-name recognition is not implemented and is out of scope.
- `speakers.display_name` is presentation only. It defaults to `화자 A`, `화자 B`,
  …, is user-editable, and must never be used as an identity key. The key is
  `(meeting_id, speaker_code)`.
- Writing a draft rewrites that meeting's `transcript_segments` but **upserts**
  its `speakers`, so a reviewer's `display_name` survives.

## Human approval invariant

**An AI-generated transcript is a draft. It cannot become RAG knowledge until a
human explicitly reviews and approves it.**

This is enforced by runtime behaviour, not by UI affordances:

- `app/services/pipeline.py:process` ends at `REVIEW_REQUIRED`. It does not
  chunk and does not embed.
- `app/services/pipeline.py:index_transcript` is the only code that creates
  chunks or embeddings. It has exactly two triggers, both requiring a meeting a
  human has already acted on: `POST /api/meetings/{id}/approve` (first index)
  and `POST /api/meetings/{id}/reindex` (re-embed an approved meeting).
- Indexing reads the transcript from the database via `load_transcript`, never
  the in-memory draft. **The reviewed transcript is what becomes evidence.**
- Both triggers claim the meeting with the same atomic compare-and-set
  (`api/meetings.py:_claim_for_indexing`), so a repeated or concurrent request is
  a `409`, not a second index.
- Re-embedding runs the indexing phase again over the stored transcript. It
  never re-runs analysis: no FFmpeg, no STT, no diarization, and no rewrite of
  `transcript_segments` or `speakers`. Only `chunks` changes.
- Deletion is allowed only in a settled state — `REVIEW_REQUIRED`, `COMPLETED`,
  `FAILED` — with the predicate inside the `DELETE`. A meeting a background task
  is still working on is a `409`, never a cancellation.
- Transcript edits are accepted only while the meeting is `REVIEW_REQUIRED`.
  This includes speaker renames: an approved transcript is immutable, and the
  server enforces it — never rely on the UI disabling a control.
- Concurrency: `edit_transcript` takes `SELECT … FOR UPDATE` on the meeting row,
  so an approval cannot commit between the status check and the edit. An edit
  in flight when approve arrives is included in the index, never silently
  dropped from it.

Status flow:

```
UPLOADED → TRANSCRIBING → DIARIZING → REVIEW_REQUIRED → INDEXING → COMPLETED
                                                     ↘ (indexing failure)   │
                                                       REVIEW_REQUIRED      │
                                                       + error              │
                                          INDEXING ◄────── re-embed ────────┘
                                             └─ (failure) COMPLETED + error,
                                                previous index intact
```

`COMPLETED` means *approved and indexed*. Analysis failure gives `FAILED`. A
failed first index returns to the gate so the reviewer can retry, with the
transcript preserved. A failed re-embed returns to `COMPLETED`: the previous
chunks were never deleted, so the meeting stays searchable exactly as it was.

**Legacy scope.** The invariant binds everything the current code indexes. It is
not retroactive: rows written before the gate existed reached `COMPLETED` without
approval, and the schema records no approval fact, so `COMPLETED` alone does not
prove a human approved that row. Treat `COMPLETED` as "approved" only for
meetings indexed by the current code. See "Known limitations".

Rationale and rejected alternatives:
[docs/decisions/2026-08-20-hitl-transcript-review-gate.md](docs/decisions/2026-08-20-hitl-transcript-review-gate.md).

## RAG / provenance invariant

An answer without traceable evidence is a defect. Every retrieved source carries,
and every API response must keep:

| field | source |
|---|---|
| `meeting_id`, `meeting_title` | `meetings` |
| `speakers` | `chunks.speaker_codes` resolved through `speakers.display_name`, or the fact's participants |
| `start_time`, `end_time`, `time_label` | `chunks` or `meeting_facts` |
| `text` | `chunks.content`, or `meeting_facts.source_text` — verbatim transcript either way |
| `score` | cosine similarity |

A structured source carries `fact_id`, `fact_type`, `summary`, `participants`,
`deadline_text` / `deadline_at`, `status_label`, `meeting_date` /
`meeting_date_label`, and `source_segment_ids` on top
of that. **A structured claim with no original words behind it is never
returned**: `meeting_facts.source_segment_ids` is `CHECK`-constrained non-empty,
and `text` is always the transcript.

- `app/services/rag.py:serialize_sources` is the single place that shapes this.
  Do not build a second serializer.
- **How many sources are shown is presentation; how many exist is not.** The
  chat shows no evidence until asked: under an answer sits one line,
  근거 N개 보기, and opening it reveals every retrieved source with its full
  transcript text (`features/chat/SourceList.tsx`). Retrieval still runs Top-K
  over both layers, the model still receives every retrieved source, and the
  response and `chat_messages.sources` still carry all of them. Never drop a
  source to shorten a screen, and never clamp a quotation the reader opened in
  order to check.
- Retrieval is restricted to `COMPLETED` meetings. Chunks are generated from the
  approved transcript, so evidence always reflects what a human signed off on.
- Chunk content is stored as rendered `화자 A: …` lines, so the evidence text is
  readable on its own.
- The prompt restricts the model to the supplied evidence and requires it to say
  it found nothing rather than guess. Do not loosen that.
- Retrieval failure and answer-generation failure are distinct. When the LLM call
  fails, the evidence is still returned.

## Database boundary

- The application owns exactly one schema: `minutes` (`DATABASE_SCHEMA`).
- Tables: `meetings`, `speakers`, `transcript_segments`, `chunks`,
  `meeting_summaries`, `meeting_categories`, `users`, `auth_sessions`,
  `chat_sessions`, `chat_messages`, `meeting_facts`,
  `meeting_fact_participants`, `meeting_user_speakers`, `schema_migrations`.
- **A meeting has at most one category, and a category owns no meetings.**
  `meetings.category_id` is a nullable FK to `meeting_categories` with
  `ON DELETE SET NULL`; `NULL` is 미분류. `meeting_categories.name` is `UNIQUE`,
  which *is* the duplicate policy — no application-side check precedes an
  insert. Deleting a category must never delete a meeting. There is no tag join
  table and no parent column: adding either is a decision record.
- **Never issue DDL or DML against any other schema in this database.** The
  instance is shared — `didim_rag` and other application schemas live beside
  `minutes` and are out of bounds.
- The one database-wide statement is `CREATE EXTENSION IF NOT EXISTS vector`.
  It only adds; it is the only permitted global effect.
- **Schema changes are a deployment step, never a startup side effect.** DDL
  lives in `scripts/migrations/*.sql` and is applied only by
  `python -m scripts.migrate`. Nothing in `app/` issues `CREATE`, `ALTER`, or
  `DROP`.
- A new schema change is a new numbered file. Never edit a migration that has
  already been applied anywhere — the applied version is recorded, so an edit
  simply never runs.
- Each migration is applied inside one transaction together with its
  `schema_migrations` row. A failure rolls back and records nothing.
- Migrations only ever add. No `DROP`, no recreate, no reset: a deployed database
  holds real meetings, and every file must be safe against one that already has
  most of the schema.
- `app/main.py` calls `migrate.verify()` at startup. It is **read-only**: it
  refuses to serve an unmigrated database and checks the vector width against the
  loaded embedding model. It never repairs anything.
- Prefer PostgreSQL to application code: foreign keys, `UNIQUE`, `ON DELETE
  CASCADE`, `ON CONFLICT`, transactions, and indexes already carry rules that
  Python must not re-implement.

## AI model responsibilities

Each component does one thing. Do not describe or use them interchangeably.

| component | responsibility |
|---|---|
| FFmpeg | audio normalization to 16 kHz mono WAV |
| faster-whisper | speech → text with segment timestamps, language detection |
| pyannote | speaker diarization — *who spoke when*, nothing else |
| `transcript.assign_speakers` | joins the two timelines by overlap |
| BGE-M3 | embedding of chunk text and of the query |
| pgvector | vector storage and cosine retrieval |
| BGE-M3 (again) | embedding of a fact's canonical text — the same model, the same 1024 dims |
| OpenAI | answer generation from retrieved evidence; meeting summary and STT correction suggestions; fact extraction; query planning |

Whisper does not determine speakers. pyannote does not produce text. The OpenAI
call is never a retrieval step and never a source of facts.

`services/assist.py` is the whole-transcript direction: it reads the meeting and
writes a summary, or proposes corrections. It never writes `transcript_segments`
and never changes `meetings.status`.

`services/intelligence.py` extracts structure from the same approved transcript.
It never writes `transcript_segments`, never changes `meetings.status`, and
never invents a participant, a date, or a source. The model proposes; SQL and
`_validate` decide what is stored.

The three fact types are not interchangeable, and one exchange can produce more
than one:

| type | what it is | the speaker of the source utterance is |
|---|---|---|
| `REQUEST` | somebody asks somebody else to do something | the `REQUESTER` |
| `DECISION` | something the meeting settled | the `DECIDER` |
| `ACTION_ITEM` | **the speaker's own explicit promise or acceptance to do something** | the `ASSIGNEE` |

A request and the acceptance that answers it are **two facts**, each citing its
own utterance. Neither replaces the other, and the application never derives one
from the other — an unanswered request stays a request with no assignee.

What separates a commitment from plain agreement ("네, 알겠습니다"), a past
action, or a possibility is meaning, and that decision lives in
`intelligence.EXTRACT_PROMPT` alone. `_validate` checks provenance, speakers, and
enums; **do not grow it into a semantic classifier** — two disagreeing
definitions of ACTION_ITEM in one codebase is worse than either.

**Time comes from the meeting, not from the row.** `meetings.created_at` is
when the recording was uploaded and nothing else. Anything that means "when this
happened" — cross-meeting ordering, the base date a relative deadline resolves
against — reads `coalesce(held_at, created_at)`, and when the fallback is in use
the date is labelled a registration date wherever it is rendered. Never add a
second date column to a fact: a fact's place in time is its meeting's date plus
its `start_time`.

`held_at` may be **proposed** by a client and is never **inferred** by the
server. `POST /api/meetings` accepts it as an optional form field; the upload
dialog pre-fills the browser's current local time, which the user can change or
clear before sending. Absent or empty is `NULL`, a malformed value is a `400`,
and the column has no `DEFAULT now()` — a default would make every future row
claim its upload time as a meeting date, which is the mistake migration 005
exists to undo. Existing `NULL` rows are never backfilled.

`rag.plan` is a retrieval aid, not a second answerer. It resolves a follow-up
into a standalone search query and names which facts to filter for. Its output
is validated against enums and never interpolated into SQL, and every failure
falls back to the question as typed.

## UI boundary

- Routes: login (`/login`), meeting list + upload (`/`, `/meetings`), meeting
  detail (`/meetings/:meetingId`), chat (`/chat`, `/chat/:sessionId`). They are
  client-side routes; FastAPI answers all of them with the same SPA entry point.
- **A missing `/api/...` is a `404`, never the SPA entry point.** An API caller
  must not have to parse HTML to learn its request was wrong.
- The React app renders nothing the server injected. Every value it shows comes
  from a JSON endpoint, including the signed-in user (`GET /api/auth/me`).
- Server state lives in TanStack Query and nothing else. There is no Redux,
  MobX, or Zustand: the authoritative copy of a meeting, a chat, or a scope is
  the database, and the browser must not hold a second one.
- **There is one sidebar.** `components/AppShell.tsx` owns a single `<aside>`
  holding the route nav, the chat conversation list (on `/chat` only), and the
  user footer; below `md` the same element is a top bar and the conversation
  list collapses behind one button. `ChatNav` is mounted exactly once and reads
  the session list itself. A second panel beside the sidebar, or a second mount
  of the list for small screens, is the thing this replaced.
- **The conversation has one centre axis.** `features/chat/canvas.ts:CANVAS` is
  the reading column, and the scope bar, the messages, the evidence, and the
  composer all sit on it. The composer is sticky and never spans the window.
- The meeting detail page doubles as the review screen: at `REVIEW_REQUIRED` its
  transcript rows become editable and an approval panel appears. There is no
  separate review page.
- **Narrowing a meeting list happens in one predicate.** `lib/meetings.ts`
  (`matches`, `meetingTime`, `RANGES`) is shared by the meeting list toolbar and
  the chat scope dialog. Filtering is client-side over the full
  `GET /api/meetings` response; adding filter/sort query parameters is a
  deliberate change, not a drive-by.
- **Category management is its own route, `/categories`; filtering by category
  is not.** The meeting toolbar keeps only a quiet link to it, because narrowing
  a list is constant and renaming a label is rare, and a toolbar that offers both
  at the same weight says they are equally important. Deleting a category says
  how many meetings move to 미분류 before the click. `/categories` is reached
  from the meeting list, not from the sidebar: it is management, one level below
  navigation.
- **A conversation's name is editable and the auto-title never overwrites it.**
  `PATCH /api/chat/sessions/{id}/title` trims, caps at `TITLE_MAX`, and refuses
  a blank name; the first-question auto-title only fires while the title is still
  the default sentinel, so no extra column is needed to protect a chosen name.
  The sidebar row and the chat header read the same session, so they cannot
  disagree.
- **A question, an answer, its evidence, and a notice look different.** A
  question is a right-aligned bubble; an answer is prose with no card, so it does
  not compete with its own evidence; evidence is a bordered secondary block; and
  the two answers the backend writes itself (`rag.NO_ANSWER`, `rag.NO_IDENTITY`,
  matched by `lib/labels.ts:isNoticeAnswer`) render as a notice, because they are
  guidance about the search rather than a finding from a meeting.
- **An unapproved meeting explains itself instead of looking empty.**
  `features/meetings/PendingNotice.tsx` is the one place that says which status
  the meeting is in, why that status has no summary or facts, and what the next
  human action is; the overview and the intelligence panel both use it. Skeleton
  rows there were a lie — nothing was loading. It never fabricates a draft
  summary or a provisional fact.
- Progress is observed by polling. Intervals live in
  `frontend/src/api/queries.ts` (`POLL_LIST` 3000, `POLL_MEETING` 2000,
  `POLL_INTEL` 3000), and the meeting poll stops once the status settles. There
  is no SSE and no WebSocket.
- React escapes what it renders. Never reach for `dangerouslySetInnerHTML`.
- The chat page is a sidebar of past chats plus one conversation. The meeting
  scope is chosen in a dialog with a searchable checkbox list, not a `<select>`;
  a `<select>` stops being usable as meetings accumulate.
- Speaker colour is decoration. The display name is always rendered next to it,
  so colour is never the only way to tell speakers apart.
- **Every dialog is `components/ui/Dialog.tsx`, which wraps Radix Dialog.** Focus
  trapping, ESC, the backdrop, `aria-modal`, and restoring focus come from the
  primitive; there is no second close path to drift out of sync with the first,
  and no `hidden` attribute fighting an author `display` rule. 선택 완료 closes
  only after the server accepts the PATCH.
- Colour, spacing, radius, and type come from the tokens in
  `frontend/src/index.css`. A screen never invents its own shade, and one status
  is one colour everywhere.
- The meeting detail page shows Meeting Intelligence for `COMPLETED` meetings
  only, and every fact renders the transcript text it came from.
- There is no admin view and no user administration.

## Identity and chat invariant

The login is an identity boundary, not an authorization system.

- `app/main.py:require_login` runs before every route. Every `/api/*` path is
  closed except `POST /api/auth/login`, so a new endpoint is protected the moment
  it is written; an anonymous API call is a `401`. The SPA entry point is public
  and is the same bytes for everyone — it carries no user data, and the browser
  learns who it is from `GET /api/auth/me`. **Never rely on the UI hiding a
  control.**
- The session stays an `HttpOnly` cookie. The frontend never reads it, never
  stores a token in `localStorage` or `sessionStorage`, and sends no
  `Authorization` header. Same-origin is what makes that work.
- No secret reaches the browser bundle. There is no `VITE_`-prefixed key for a
  server-side setting, and `tests/test_frontend.py` checks the built output.
- Passwords are stored as `scrypt` hashes from the stdlib (`services/auth.py`).
  Plaintext is never stored, logged, or returned.
- The session cookie carries an opaque random token. `auth_sessions` is the whole
  authority, so logout is a `DELETE` and an edited cookie resolves to nobody.
  There is no signing secret to configure.
- **`minutes.users` is the source of truth for accounts, not the environment.**
  The POC account is seeded by migration `003_user_identity` with a precomputed
  hash and `WHERE NOT EXISTS`, so a re-run never resets a password. There is no
  signup route and no startup code that creates a credential.
- `users.id` is the internal BIGINT key that `auth_sessions` and `chat_sessions`
  reference. `users.username` is what a person types on the login form. They are
  not interchangeable.
- `is_active` is checked in `resolve_session`'s query, not only at login: an
  existing cookie must stop working the moment the account is deactivated.
- **A user's identity inside a meeting is `meeting_user_speakers`, never a name
  match.** `SPEAKER_00` is a per-meeting diarization label, and `display_name`
  is editable text; neither identifies an account. "내가 요청한 것" resolves
  through this table or it is refused (`rag.NO_IDENTITY`), never guessed.
- A self-scoped question is answered from facts only. The dense chunk layer has
  no participant filter, so mixing it in would put another person's request in
  front of a model asked about mine.
- The mapping is always written from `request.state.user`. No endpoint accepts a
  `user_id` from a client. The database refuses a speaker from another meeting
  (composite FK) and a speaker another user already claimed (`UNIQUE`).
- Claiming a speaker is allowed after approval. It is identity, not transcript
  text, and changes no word of the approved minutes.
- `last_login_at` is written on a successful login only. A failed attempt must
  leave it untouched.
- **Every chat query filters on `user_id`.** Another user's session id is a
  `404`, never a `403` and never their data. This is the only ownership rule in
  the system; meetings deliberately have none.

## Chat scope invariant

**A chat that names the meetings to search is never widened by the backend.**

- `chat_sessions.scope_meeting_ids` is the scope. Empty means the whole corpus;
  a non-empty array is a hard restriction applied as `meeting_id = ANY(...)` in
  **both** retrieval layers — `rag.search` over `chunks` and
  `intelligence.search` over `meeting_facts`. A new retrieval path that does not
  take the same parameter and apply the same predicate is a defect.
- The retrieval query may be rewritten from the conversation (`rag.plan`), but a
  rewrite never touches the scope. Scope comes from the session row, never from
  the text of a question.
- When a scoped question finds nothing, the response carries `scope_miss` and the
  browser offers 전체 회의에서 검색. **No automatic fallback, ever** — answering
  from a meeting the user excluded is a correctness failure, not a convenience.
- The explicit retry (`global_override`) widens that one request only. The
  session's own scope is unchanged; changing it is a separate action.
- The miss signal is `rag.NO_ANSWER`, the same sentence the evidence prompt tells
  the model to produce. There is no relevance threshold and no second judge.

## Dependency boundary

`requirements.txt` is the complete runtime dependency set. Adding to it is a
decision, not a convenience — see the Ponytail boundaries in `CLAUDE.md` and
record it under `docs/decisions/`.

## Persistence boundary

Audio (original and its `.16k.wav` normalization) lives on disk under
`UPLOAD_DIR`; everything structured lives in the `minutes` schema; model weights
live under `HF_HOME`. Each maps to a named Docker volume so a rebuild loses
nothing. Exact locations:
[docs/architecture/current.md](docs/architecture/current.md#persistence).

The invariant: **analysis state lives only in `meetings.status`.** There is no
job table and no queue. Do not introduce a second source of truth for progress.

## Secret / security boundary

- `.env` is git-ignored and must stay that way. `.env.example` carries
  placeholders only.
- `HF_TOKEN`, `OPENAI_API_KEY`, and `DATABASE_PASSWORD` are read from the
  environment in `app/config.py` and nowhere else.
- Never write a credential into source, README, `docs/`, a test fixture, a log
  line, or a commit.
- Never echo a secret value into terminal output when inspecting configuration.
- The application has no authentication. It must not be exposed to the public
  internet as-is.

## Verification invariant

- A change is done when evidence says so, not when the edit is saved.
- Report PASS, FAIL, and SKIP separately. If tests were skipped, say how many
  and why.
- Never describe a partial run as a full pass.
- Commands are in `CLAUDE.md`; only commands that actually exist in this
  repository belong there.

## Deployment boundary

- One container: the application. PostgreSQL is external, always.
- `compose.yaml` exposes `18080:8000`.
- Model cache and uploads live in named volumes so a rebuild does not re-download
  or lose data.
- NCP deployment is **not yet a repository invariant** — it has never been
  performed. Do not write a runbook for it until it has actually been done.

## Known limitations

Current, verified facts. Not a to-do list.

- **Background work is not durable.** `BackgroundTasks` runs in-process; a
  restart mid-analysis loses the job and leaves `status` at an intermediate
  value. There is no resume and no retry.
- **No concurrency control.** Simultaneous uploads compete for the same
  in-process models.
- **One speaker per STT segment.** A segment that spans a speaker change is
  attributed wholly to the dominant speaker; splitting it needs word-level
  timestamps.
- **`error_message` is overloaded.** It carries a diarization-fallback *warning*
  on `REVIEW_REQUIRED`, and an indexing error when approval fails. The UI renders
  both in the error style. Kept as-is: a separate warning channel would be a new
  subsystem for one string.
- **A meeting stuck mid-processing cannot be deleted.** A restart abandons the
  background task and leaves the row at `TRANSCRIBING`, `DIARIZING`, or
  `INDEXING`, which deletion refuses. No cancellation or force-delete was added.
  An operator can move such a row to `FAILED` with one `UPDATE`, after which the
  normal delete works — no new code is involved.
- **An approved meeting cannot be re-opened for review.** No route moves
  `COMPLETED` back to `REVIEW_REQUIRED`, so correcting an indexed transcript is
  not currently possible.
- **Legacy `COMPLETED` rows predate the approval gate.** As of 2026-08-20 the
  shared database holds three meetings, all synthetic demo audio; two (`id 1`,
  `id 2`) were auto-indexed before the gate existed and were never human
  approved, and they remain retrievable because retrieval keys on `COMPLETED`.
  The schema stores no approval timestamp or flag, so approved and legacy rows
  are indistinguishable from data alone. No approval marker was added and no row
  was modified — see the decision record for why, and for the remediation the
  current code already supports.
- **Diarization is verified on the NCP host only.** One real run there
  separated `SPEAKER_00` and `SPEAKER_01` over 183.72 s of Korean audio with no
  fallback warning. It needs an `HF_TOKEN` whose account has accepted the model
  licence, plus `pyannote.audio>=4.0.3` (4.0.0 cannot load the checkpoint under
  `torch` 2.13). The WSL workspace has neither an accepting token nor a cached
  model, so a local run still takes the single-speaker fallback.
- **Answer generation is verified on the NCP host only.** One real generation
  has been observed there: `POST /api/chat` returned a cited answer over three
  sources with provenance intact, using `gpt-4o-mini` against pre-existing rows.
  The `OPENAI_API_KEY` in the WSL development workspace is a different key and
  still returns `invalid_organization` (401), so a local run gets evidence
  without a generated answer.
- **Retrieval is dense-only.** Exact keyword, proper-noun, and numeric matching
  are weak. This is true of `meeting_facts` as well as `chunks`.
- **Facts are only as good as one extraction pass.** `meeting_facts` is produced
  by an LLM over the approved transcript with no human review step of its own.
  Validation guarantees provenance and refuses invented speakers and dates; it
  cannot guarantee that a real request was noticed. A missing fact is invisible.
  Recall is a prompt property and cannot be regression-tested with a stubbed
  model: the suite pins what the prompt instructs and what the pipeline does
  with a given extraction, not what the live model returns.
- **Fact status is never inferred.** `UNKNOWN` is the default for every fact
  type, including `ACTION_ITEM`; only an explicit statement in the meeting
  produces `OPEN`, `DONE`, `CANCELLED`, or `DEFERRED`. "아직 안 끝난 것"
  therefore returns `UNKNOWN` facts too, and the answer says the meeting never
  mentioned completion rather than calling them incomplete.
- **Cross-meeting change is chronology, not a linked graph.** Retrieved
  `DECISION` facts are ordered by meeting date and compared by the model. There
  is no `SUPERSEDES` edge, so "이 결정이 저 결정을 뒤집었다" is a reading of the
  timeline rather than a stored relationship.
- **A deadline resolves only when the year, month, and day are all pinned.**
  `오늘/내일/모레`, weekday expressions, and year-bearing forms (`YYYY-MM-DD`,
  `YYYY년 M월 D일`) get a `deadline_at`. A bare `M월 D일` does not: no year was
  stated. Everything else keeps `deadline_text` and leaves the date NULL.
- **The meeting's own date has to be entered.** `meetings.held_at` is what
  relative deadlines and cross-meeting chronology read; it is NULL until someone
  sets it, and the fallback to `created_at` is labelled `등록` wherever it is
  shown. Nothing may present an upload time as when a meeting happened. The
  upload dialog now proposes today, so new uploads normally arrive with a date —
  but as of 2026-08-21 all six meetings in the shared database still have
  `held_at = NULL`, and nothing backfills them.
- **The evidence under an answer starts closed.** The count is shown, the
  content is not, until the reader opens it. Nothing is discarded to achieve
  that — see the provenance rules above.
- **A meeting list is filtered in the browser.** Text, category, status, and
  date-range filters run over the whole `GET /api/meetings` response. There is
  no pagination, so a corpus large enough to need it will need a server-side
  query first.
- **A category is a label a person picks, not a retrieval filter.** Nothing in
  the pipeline or in retrieval reads `category_id`; chat scope is still
  `meeting_ids`.
- **Speaker identity is per meeting and set by hand.** `meeting_user_speakers`
  has to be set once per meeting per user. There is no cross-meeting voice
  identity and no propagation, so "지난달 내가 요청한 것" only covers meetings
  where the mapping was set.
- **Extraction is not cheap on a long meeting.** One OpenAI request per 40-segment
  window, run automatically after every approval. There is no cost ceiling and no
  cancellation.
- **A follow-up is now resolved for retrieval, at the cost of one call.**
  `rag.plan` rewrites "그 부서는?" into a standalone query before embedding. It
  is a second OpenAI request on every question, and when it fails retrieval
  silently falls back to the words as typed — the old behaviour, with no signal
  in the response that it happened.
- **The login is not transport security.** The deployment is plain HTTP, so the
  session cookie is not sent with `secure` and is readable on the wire. HTTPS
  termination is still required before this is exposed beyond a trusted network.
- **Expired sessions are not swept.** `auth_sessions` rows older than seven days
  stop resolving but are never deleted. No cleanup job was added for a table that
  grows by one row per login.
- **A chat scope can name a deleted meeting.** `scope_meeting_ids` is an array
  with no foreign key, so the id simply retrieves nothing. The picker only offers
  meetings that exist.
- **Summarization is a single request.** The whole transcript goes to the model
  at once; a recording long enough to exceed its context would fail rather than
  degrade.
- **CPU inference in the current environment.** The local GPU driver (CUDA 12.6)
  is older than the installed torch build and has insufficient free VRAM.

## Planned, not current

Not implemented. Do not document these as existing behaviour.

- Durable queue and a separate GPU worker process.
- Object storage for uploaded audio.
- Hybrid lexical + dense retrieval, and reranking.
- NCP deployment.
