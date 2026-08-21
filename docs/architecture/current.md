# Current architecture

Snapshot of what the source actually does, as of 2026-08-20.
Boundaries and rules live in [AGENTS.md](../../AGENTS.md); this file describes structure.

## Runtime components

| component | where it runs | notes |
|---|---|---|
| FastAPI application | one process, `uvicorn app.main:app` | serves the built SPA, the JSON API, and the analysis pipeline |
| PostgreSQL 16 + pgvector | external, pre-existing instance | shared with other applications; `minutes` schema only |
| FFmpeg | subprocess | system binary, or the `imageio-ffmpeg` static build |
| faster-whisper | in-process | CTranslate2, model cached under `HF_HOME` |
| pyannote.audio | in-process | gated model, needs `HF_TOKEN` |
| BGE-M3 (sentence-transformers) | in-process | 1024-dim |
| OpenAI Chat Completions | network call | chat answers, meeting summary, STT correction suggestions |
| Browser UI | client | React + TypeScript SPA, built by Vite, served by the same FastAPI process |

There is no worker process, no queue, no database container, and no Node
process at runtime. One repository, one image, one container, one origin.

## Application module map

```
app/
├── main.py                  FastAPI app, lifespan (migration check + pool),
│                            require_login middleware, /health, and the SPA
│                            fallback that serves frontend/dist
├── config.py                env → module constants; resolve_device(); ALLOWED_EXT
├── db.py                    psycopg pool, conn(), conninfo(). No DDL.
├── api/
│   ├── auth.py              POST login/logout, GET me
│   ├── meetings.py          POST/GET meetings, GET status, DELETE meeting,
│   │                        PATCH transcript, POST approve, POST reindex,
│   │                        PATCH speaker name, GET/POST summary,
│   │                        POST corrections, PUT me (user↔speaker),
│   │                        PUT held-at, PUT category,
│   │                        GET intelligence, POST intelligence/rebuild
│   ├── categories.py        GET/POST meeting-categories, PATCH/DELETE one
│   └── chat.py              chat session CRUD, POST session messages
├── services/
│   ├── pipeline.py          process() — analysis, stops at the review gate;
│   │                        index_transcript() — post-approval indexing, also
│   │                        re-run by reindex; load_transcript(),
│   │                        _persist_transcript()
│   ├── audio.py             ffmpeg_bin(), meeting_files(), to_wav16k(),
│   │                        duration_seconds()
│   ├── transcription.py     faster-whisper, cached model
│   ├── diarization.py       pyannote, cached pipeline
│   ├── transcript.py        assign_speakers() — overlap join
│   ├── chunking.py          build_chunks() — utterance-aware
│   ├── embedding.py         cached model, dimension(), encode(), encode_one()
│   ├── auth.py              scrypt hashing, opaque sessions, is_active enforcement
│   ├── assist.py            summarize(), suggest_corrections() — whole-transcript
│   │                        OpenAI calls; neither writes to the transcript
│   ├── intelligence.py      build() — approved transcript → validated facts;
│   │                        claim(), run_build(), after_approval();
│   │                        search(), my_speakers(); deadline_date()
│   └── rag.py               plan(), search(), build_context(), answer(),
│                            serialize_sources(), is_miss()

frontend/                    React + TypeScript, built by Vite. Node is a
│                            build-time tool only; nothing here runs in production.
├── index.html               the shell FastAPI serves for every client route
├── vite.config.ts           react + tailwind plugins, dev proxy, vitest config
├── src/
│   ├── main.tsx             QueryClient, BrowserRouter, ErrorBoundary, Toaster
│   ├── App.tsx              routes + RequireAuth
│   ├── index.css            the design tokens - colour, type, radius, speakers
│   ├── api/
│   │   ├── client.ts        fetch wrapper, ApiError, upload() with progress
│   │   ├── types.ts         the API boundary, typed by hand
│   │   └── queries.ts       every useQuery/useMutation, POLL_* intervals
│   ├── lib/                 format.ts (time/date, nowLocalInput),
│   │                        labels.ts (enum → Korean), meetings.ts (the one
│   │                        list predicate + RANGES), speakers.ts (colour)
│   ├── components/          AppShell (the single sidebar), ErrorBoundary,
│   │                        ui/ primitives (Button, controls, Badge, Panel,
│   │                        Dialog, Menu, feedback)
│   ├── routes/              LoginPage, MeetingsPage, MeetingPage,
│   │                        CategoriesPage, ChatPage, NotFoundPage
│   ├── features/
│   │   ├── meetings/        UploadDialog, HeldAtField, CategoryField,
│   │   │                    PendingNotice, SpeakerBar, TranscriptPanel,
│   │   │                    CorrectionPanel, SummaryPanel, IntelligencePanel,
│   │   │                    FactCard, DangerZone
│   │   └── chat/            ChatNav (mounted in AppShell), canvas.ts (CANVAS),
│   │                        Conversation, Composer, ScopeDialog, SourceList
│   └── test/                Vitest suites + the fetch-stub harness
└── e2e/                     Playwright browser smoke over the production build

scripts/migrate.py           migration runner: run(), verify(). The only DDL path.
scripts/migrations/*.sql     001_initial, 002_productization, 003_user_identity,
                             004_meeting_intelligence, 005_meeting_held_at,
                             006_meeting_categories
tests/conftest.py            DB detection, migration run, fake embeddings, fake
                             fact extraction, throwaway accounts and meetings,
                             logged-in clients
tests/test_core.py           6 unit tests, no model or DB access
tests/test_migrate.py        17 tests over the runner, using throwaway schemas
tests/test_hitl.py           23 tests over the approval gate, re-embedding, and
                             deletion; real DB, faked embeddings
tests/test_auth.py           17 tests over the identity boundary
tests/test_chat.py           18 tests over chat ownership, multi-turn, and scope
tests/test_assist.py         12 tests over summary and correction suggestions
tests/test_intelligence.py   52 tests over fact extraction, validation, rebuild
                             atomicity, and the user↔speaker mapping
tests/test_retrieval.py      22 tests over relationship, temporal, and follow-up
                             retrieval through the chat API
tests/test_frontend.py       12 checks on SPA/API route priority, deep links,
                             path traversal, and secrets in the built bundle
tests/test_categories.py     15 tests over category CRUD, the UNIQUE(name)
                             conflict, assignment, delete-keeps-the-meeting,
                             and held_at on upload
```

Dependencies point one way: `api/` → `services/` → `db.py` → PostgreSQL.
`pipeline.py` orchestrates the audio pipeline; `intelligence.py` reads the
transcript through `pipeline.load_transcript` and reuses `assist._complete` for
its OpenAI call, and `rag.py` reads facts through `intelligence.search`. Nothing
imports back the other way.

## Schema lifecycle

Two responsibilities, deliberately separated:

```
deployment       python -m scripts.migrate     creates and alters the schema
application      uvicorn app.main:app          connects and serves; no DDL
```

`scripts/migrate.py` applies every file in `scripts/migrations/` in filename
order, exactly once. Each file runs inside one transaction together with the
`schema_migrations` row that records it, so a failure rolls the file back and
records nothing — the next run retries it rather than skipping it. `{{SCHEMA}}`
is substituted from `DATABASE_SCHEMA`; nothing else is templated.

| file | contents |
|---|---|
| `001_initial.sql` | `vector` extension, `meetings`, `speakers`, `transcript_segments`, `chunks` and their indexes |
| `002_productization.sql` | `users`, `auth_sessions`, `chat_sessions`, `chat_messages`, `meeting_summaries` |
| `003_user_identity.sql` | `users.display_name`, `is_active`, `updated_at`, `last_login_at`; seeds the POC account |
| `004_meeting_intelligence.sql` | `meeting_facts`, `meeting_fact_participants`, `meeting_user_speakers`, `meetings.intelligence_state` / `intelligence_error` |
| `005_meeting_held_at.sql` | `meetings.held_at`; widens `meeting_facts.status` with `UNKNOWN` and makes it the default |

`005` is the one file that drops something: the anonymous `status` CHECK, which
it immediately re-adds accepting one more value. Widening a constraint cannot
reject a row that already exists, and no data is touched.

Every other statement is `IF NOT EXISTS` or `ADD COLUMN IF NOT EXISTS`, so a database
that already holds meetings — the deployed one — records the early versions
without changing a row. No migration drops or recreates anything.

The vector width is a literal `vector(1024)` in `001`, not a runtime lookup: a
migration records what was built, and changing `EMBEDDING_MODEL` means a new
migration plus re-embedding every row.

## Startup sequence

`app/main.py` lifespan, in order:

1. `embedding.dimension()` — loads BGE-M3 and reads its dimension. This is the
   first network/disk cost and dominates cold start.
2. `migrate.verify(dim)` — **read-only**. On a standalone connection it checks
   that every migration version is recorded and that `chunks.embedding` matches
   `dim`, and raises otherwise. It repairs nothing.
3. `db.init_pool()` — opens the pool. Each connection sets `search_path` to the
   schema and registers the pgvector type.

`verify` runs before the pool and does not use it: on an unmigrated database the
pool cannot register the `vector` type, and the operator would see a connection
error instead of the sentence telling them to run the migration.

## Data flow

```
Browser
  │  POST /api/meetings  (multipart: file, title, held_at?)
  ▼
api/meetings.py  ── extension check ──► reject 400
  │              └─ held_at parse   ──► reject 400 (empty ⇒ NULL, never now())
  │  write UUID-named file to UPLOAD_DIR
  │  INSERT meetings (status='UPLOADED', held_at)
  │  BackgroundTasks.add_task(pipeline.process)
  └─► responds immediately
        │
        ▼  (background, same process)
   pipeline.process
        │  status=TRANSCRIBING
        ▼
   audio.to_wav16k ──► <upload>.16k.wav (16 kHz mono)
        │
        ├─► audio.duration_seconds ──► UPDATE meetings.duration, .language
        │
        ▼
   transcription.transcribe ──► [{start, end, text}], language
        │        (empty result ⇒ meeting FAILED)
        │  status=DIARIZING
        ▼
   diarization.diarize ──► [{start, end, speaker}]
        │        (failure ⇒ [] + warning, continue)
        ▼
   transcript.assign_speakers  ── overlap join ──► [{start, end, text, speaker}]
        ▼
   _persist_transcript ──► rewrite transcript_segments, UPSERT speakers
        │  status=REVIEW_REQUIRED   (error_message may hold a diarization warning)
        ▼
   ══════════════ HUMAN APPROVAL GATE ══════════════
   No chunks. No embeddings. Not retrievable.
   Reviewer may edit segment text, reassign speakers, rename speakers.
        │
        │  POST /api/meetings/{id}/approve
        │  atomic CAS: status REVIEW_REQUIRED → INDEXING  (else 409)
        ▼  (background, same process)
   pipeline.index_transcript
        │
        ▼
   load_transcript ──► reads the CURRENT transcript from the database,
        │              not the draft the analysis phase held in memory
        ▼
   chunking.build_chunks ──► [{sequence, content, start_time, end_time, speaker_codes}]
        ▼
   embedding.encode ──► 1024-dim normalized vectors
        ▼
   DELETE+INSERT chunks (with embedding)   ← one transaction
        │  status=COMPLETED
        │  (on failure: back to REVIEW_REQUIRED, transcript preserved)
        ▼
   PostgreSQL / pgvector

        ▲  POST /api/meetings/{id}/reindex
        │  atomic CAS: status COMPLETED → INDEXING  (else 409)
        └──── re-enters pipeline.index_transcript with on_failure='COMPLETED'.
              No audio, no STT, no diarization, no transcript rewrite; the
              chunks are rebuilt from the stored transcript. On failure the
              previous chunks are still there and the meeting stays COMPLETED.


Browser
  │  every request ──► main.require_login
  │                     ├─ not /api/*, or POST /api/auth/login → through
  │                     ├─ no session + /api/*  → 401
  │                     └─ session → request.state.user
  │                    (a non-API path then falls through to the SPA route:
  │                     a real file under frontend/dist, else index.html.
  │                     An unmatched /api/... is a 404, never index.html.)
  ▼
  │  POST /api/chat/sessions/{id}/messages  {question, global_override, top_k}
  ▼
api/chat.py
  ├─ SELECT chat_sessions WHERE id AND user_id       (ownership, else 404)
  ├─ last rag.HISTORY_MESSAGES rows of chat_messages  (oldest-first for the model)
  ├─ scope = [] if global_override else session.scope_meeting_ids
  ▼
rag.answer
  ├─ rag.plan(question, history)      one JSON call, retrieval-side only
  │    ├─ query            the follow-up resolved into a standalone question
  │    ├─ fact_types       REQUEST / DECISION / ACTION_ITEM
  │    ├─ participant_role REQUESTER / ASSIGNEE / DECIDER / null
  │    └─ self_reference   "내가 …" — resolved through meeting_user_speakers
  │       any failure (no key, bad JSON, unknown enum) → the question as typed
  ├─ intelligence.search(plan.query, scope, …)        structured layer
  │    SELECT meeting_facts WHERE m.status = 'COMPLETED'
  │           AND f.meeting_id = ANY(scope)            (only when scope is set)
  │           AND EXISTS (participant with that role / that speaker)
  │           ORDER BY embedding <=> query LIMIT k
  │    then re-sorted by (coalesce(m.held_at, m.created_at), start_time) —
  │    chronological by when the meetings were held, not when they were uploaded
  ├─ rag.search(plan.query, scope, …)                  dense layer, unchanged
  │    SELECT chunks WHERE m.status = 'COMPLETED'
  │           AND c.meeting_id = ANY(scope)
  │           ORDER BY embedding <=> query LIMIT k
  │    skipped entirely when self_reference: a chunk carries no participant
  │    filter, so it could show somebody else's request as if it were mine
  ├─ sources = facts + chunks         facts first, each with its source segments
  ├─ build_context  ──► numbered evidence blocks
  ├─ OpenAI chat completion (system + prior turns + evidence-only prompt,
  │                          the question exactly as the user typed it)
  └─ serialize_sources ──► {answer, sources[]}
  ▼
  ├─ INSERT chat_messages ×2 (the question, and the answer with its sources)
  ├─ title ← the first question, truncated
  └─ scope_miss = scope was set AND (no sources OR the answer is rag.NO_ANSWER)
        │  Never a re-search. The browser offers 전체 회의에서 검색, and only a
        └─ click sends the same question again with global_override=true, which
           widens that one request and leaves the session's scope alone.


Browser
  │  POST /api/meetings/{id}/summary        (COMPLETED only)
  │  POST /api/meetings/{id}/corrections    (REVIEW_REQUIRED only)
  ▼
services/assist.py
  ├─ pipeline.load_transcript / SELECT transcript_segments   (whole meeting)
  ├─ OpenAI chat completion
  ├─ summary  ──► UPSERT meeting_summaries (one row per meeting)
  └─ corrections ──► [{sequence, before, after}], nothing written; `before` comes
                     from the database and unknown or unchanged lines are dropped
```

```
Approval (background task 2, after indexing)
  │  intelligence.after_approval(meeting_id)
  ▼
services/intelligence.py
  ├─ claim()                      COMPLETED + not already BUILDING → BUILDING
  ├─ pipeline.load_transcript     the approved transcript, with segment ids
  ├─ windows of 40 segments, 5 overlapping
  ├─ OpenAI JSON extraction per window
  ├─ _validate   unknown segment id → dropped; no source left → fact dropped
  │              speaker not of this meeting → the role goes, the fact stays
  │              status not explicitly stated → UNKNOWN, never OPEN
  │              deadline_text kept verbatim; deadline_at only when the year,
  │              month and day are all pinned, resolved against held_at
  ├─ _dedupe     same type + same sources, or same type + same wording
  ├─ embedding.encode(canonical(fact))       BGE-M3, the same 1024-dim model
  └─ one transaction: DELETE facts → INSERT facts + participants → READY
        │  Everything is extracted and embedded before the delete, so a failed
        └─ run leaves the previous facts in place and lands on FAILED.
```

`POST /api/meetings/{id}/intelligence/rebuild` is the same path, claimed
explicitly. The meeting's own `status` is never touched by either.

The list and detail pages poll (`3000 ms` / `2000 ms`) to observe `status`; the
intelligence panel polls its own endpoint while the state is `BUILDING`.

### What the screen does with an answer

```
AskResult {answer, sources[], scope_miss}
  ├─ answer is one of rag.NO_ANSWER / rag.NO_IDENTITY
  │     → rendered as a notice (lib/labels.ts:isNoticeAnswer), not as prose
  │       with evidence: it is guidance about the search, not a finding.
  └─ otherwise
        ├─ prose, on the CANVAS axis, in no card
        └─ SourceList  closed by default: one line, "근거 N개 보기"
              opened → every source in `sources[]`, full transcript text,
                       no similarity score and no chunk id on screen.
```

The count is the whole retrieved set. Nothing between `rag.serialize_sources`
and this component removes a source; `chat_messages.sources` holds the same
list, so reopening the conversation reproduces the same evidence.

### Category management

`/categories` (`routes/CategoriesPage.tsx`) is the only screen that creates,
renames, or deletes a category; the meeting toolbar filters by them and links
out to it. Both use `useCategoryMutations`, whose invalidation refetches the
category list and the meeting list together — a rename changes what every
meeting row displays. Deleting relies on `ON DELETE SET NULL`: the dialog states
how many meetings become 미분류, and no application code touches a meeting.

### Before approval

A meeting that is not `COMPLETED` has no summary and no facts, and the overview
and intelligence panels both render `features/meetings/PendingNotice.tsx`
instead — the meeting's status, why that status has no content, and the next
human action (`회의록 검토 → 저장 → 승인` at `REVIEW_REQUIRED`). No draft
summary and no provisional fact is generated to fill the space.

## Persistence

| data | location | lifetime |
|---|---|---|
| uploaded audio (`<uuid>.<ext>`) | `UPLOAD_DIR` = `data/uploads`; `uploads` volume in Docker | until the meeting is deleted |
| normalized audio (`<uuid>.16k.wav`) | same directory | same; `to_wav16k` reuses it if present |
| meetings / speakers / transcript_segments / chunks | PostgreSQL schema `minutes` | until deleted |
| meeting summary | `meeting_summaries`, one row per meeting | until regenerated or the meeting is deleted |
| users and password hashes | `users` | until the user is deleted |
| login sessions | `auth_sessions`, opaque token as primary key | 7 days, checked in SQL at every request |
| chat sessions and messages | `chat_sessions`, `chat_messages` | until the chat or its user is deleted |
| embeddings | `chunks.embedding` and `meeting_facts.embedding`, both `vector(1024)` with an HNSW cosine index | with the row |
| structured facts | `meeting_facts`, `meeting_fact_participants` | replaced on each build; deleted with the meeting |
| who the user is in a meeting | `meeting_user_speakers` | until cleared, or the meeting or user is deleted |
| model weights | `HF_HOME=/models`, `TORCH_HOME=/models/torch`; `models` volume in Docker | until the volume is removed |
| analysis progress | `meetings.status` column only | no job table, no queue |

`transcript_segments` is rewritten per analysis run and edited in place during
review; `speakers` is upserted so reviewer renames survive; `chunks` is deleted
and rebuilt on every approval.

`DELETE /api/meetings/{id}` closes the lifecycle: one `DELETE` on `meetings`
cascades to all three child tables, then both files named by `stored_filename`
are unlinked. Database first — a failed unlink leaves an unreferenced file,
whereas the other order would leave a row pointing at audio that is gone.

## Database schema

Defined in `scripts/migrations/`, applied by `python -m scripts.migrate`.

- `meetings` — `id`, `title`, `original_filename`, `stored_filename`, `duration`,
  `language`, `status`, `error_message`, `held_at` (nullable — when the meeting
  actually took place), `category_id` (nullable FK set-null — NULL is 미분류),
  `created_at` (when it was uploaded)
- `speakers` — `id`, `meeting_id` FK cascade, `speaker_code`, `display_name`;
  `UNIQUE (meeting_id, speaker_code)`
- `transcript_segments` — `id`, `meeting_id` FK cascade, `speaker_id` FK set-null,
  `sequence`, `start_time`, `end_time`, `text`; index on `(meeting_id, sequence)`
- `chunks` — `id`, `meeting_id` FK cascade, `sequence`, `content`, `start_time`,
  `end_time`, `speaker_codes TEXT[]`, `embedding vector(1024)`;
  index on `meeting_id`, HNSW `vector_cosine_ops` on `embedding`

- `schema_migrations` — `version` PK, `name`, `applied_at`
- `users` — `id` (internal BIGINT key), `username UNIQUE` (the login id),
  `password_hash`, `display_name`, `is_active`, `created_at`, `updated_at`,
  `last_login_at`
- `auth_sessions` — `id TEXT` (the cookie value), `user_id` FK cascade, `created_at`
- `chat_sessions` — `id`, `user_id` FK cascade, `title`, `scope_meeting_ids BIGINT[]`
  (empty = global), `created_at`, `updated_at`; index on `(user_id, updated_at DESC)`
- `chat_messages` — `id`, `session_id` FK cascade, `role` CHECK user/assistant,
  `content`, `sources JSONB`, `created_at`; index on `(session_id, id)`
- `meeting_summaries` — `meeting_id` PK and FK cascade, `content`, `created_at`

Categories (`006`):

- `meeting_categories` — `id`, `name TEXT NOT NULL UNIQUE`, `created_at`,
  `updated_at`
- `meetings.category_id` — nullable FK with `ON DELETE SET NULL`, plus an index
  on it. A meeting has 0 or 1 category; `NULL` is 미분류. `ON DELETE SET NULL`
  is the whole "deleting a label must not delete a meeting" rule, and
  `UNIQUE (name)` is the whole duplicate policy — neither is re-implemented in
  Python. There is no tag join table and no parent column.

Meeting Intelligence (`004`):

- `meeting_facts` — `id`, `meeting_id` FK cascade, `fact_type` CHECK
  REQUEST/DECISION/ACTION_ITEM, `content`, `status` CHECK
  UNKNOWN/OPEN/DONE/CANCELLED/DEFERRED, default `UNKNOWN`, `deadline_text`,
  `deadline_at DATE`,
  `start_time`, `end_time`, `source_segment_ids BIGINT[]` (CHECK non-empty),
  `source_text`, `embedding vector(1024)`, `created_at`; index on `meeting_id`,
  HNSW `vector_cosine_ops` on `embedding`
- `meeting_fact_participants` — `fact_id` FK cascade, `speaker_id` FK cascade,
  `role` CHECK REQUESTER/ASSIGNEE/DECIDER; PK on all three, index on
  `(speaker_id, role)`
- `meeting_user_speakers` — `meeting_id` FK cascade, `user_id` FK cascade,
  `speaker_id`, `created_at`; PK `(meeting_id, user_id)`, `UNIQUE (meeting_id,
  speaker_id)`, and a composite FK `(speaker_id, meeting_id) → speakers (id,
  meeting_id)` so a speaker from another meeting cannot be claimed
- `meetings.intelligence_state` — CHECK NOT_BUILT/BUILDING/READY/FAILED, plus
  `intelligence_error`. Separate from `meetings.status` on purpose: a failed
  extraction must not make an approved, searchable meeting look broken.

There is no `event_time` on a fact. Its position in time is
`coalesce(meetings.held_at, meetings.created_at)` plus `start_time` within it —
both already stored, and a third timestamp would be a copy that can disagree.
When the fallback is in use the rendered date is labelled `등록`: it is the
registration date, and nothing presents it as when the meeting happened.

`CREATE EXTENSION IF NOT EXISTS vector` is the only database-wide statement.

`scope_meeting_ids` is an array, not a join table, and carries no foreign key:
the two scope states differ only by whether ids are listed, and a chat that
mentions a since-deleted meeting simply retrieves nothing from it.

## Status values

```
UPLOADED → TRANSCRIBING → DIARIZING → REVIEW_REQUIRED → INDEXING → COMPLETED
                     │                       ▲                │          │
                     └──► FAILED             └────────────────┘          │
                                              indexing failure           │
                                    INDEXING ◄───── re-embed ────────────┘
                                       └─ failure returns to COMPLETED
```

`REVIEW_REQUIRED` is the human approval gate; `COMPLETED` means approved and
indexed. Written by `pipeline.set_status`, except the two transitions into
`INDEXING`, which are atomic compare-and-sets in
`api/meetings.py:_claim_for_indexing` — from `REVIEW_REQUIRED` for approval and
from `COMPLETED` for a re-embed — so that a repeated request cannot index twice.

`meetings.intelligence_state` is a second, independent state:

```
NOT_BUILT ──► BUILDING ──► READY
                  └──────► FAILED ──► BUILDING (rebuild)
```

It is not part of the analysis lifecycle above. A `FAILED` extraction leaves a
`COMPLETED` meeting fully approved, indexed, and searchable — that is the whole
reason it is a separate column.

## Failure behaviour

Observed in the source; each is deliberate.

| failure | behaviour |
|---|---|
| unsupported file extension | `400` before the file is written; no meeting row |
| FFmpeg conversion fails | `subprocess.run(check=True)` raises → meeting `FAILED` with the exception type |
| `duration_seconds` cannot parse FFmpeg output | returns `0.0`; the meeting continues with duration 0 |
| STT returns no segments | explicit `RuntimeError` → meeting `FAILED` |
| diarization fails (gated model, missing token, model error) | caught; turns = `[]`, all segments fall back to `SPEAKER_00`, analysis continues, meeting reaches `REVIEW_REQUIRED` with a warning in `error_message` — the reviewer can reassign speakers before approving |
| embedding or DB write fails during indexing | caught in `index_transcript` → meeting returns to `REVIEW_REQUIRED` with the error in `error_message`; transcript intact, chunks deleted rather than half-written |
| delete attempted while a background task runs (`UPLOADED`, `TRANSCRIBING`, `DIARIZING`, `INDEXING`) | the status predicate inside the `DELETE` matches no row → `409`; nothing is removed |
| a meeting's audio is already missing at delete time | `audio.meeting_files` returns only existing files, so the delete succeeds; the database lifecycle is what the call is for |
| `stored_filename` points outside `UPLOAD_DIR` | `audio.meeting_files` reduces it to `.name` and requires the parent to be `UPLOAD_DIR`; nothing outside is ever unlinked |
| unlink fails after the row is gone (permissions) | logged as a warning and the call still returns 200 — the meeting really is deleted; the file is orphaned disk |
| approval attempted outside `REVIEW_REQUIRED` | atomic `UPDATE` matches no row → `409`; no indexing starts |
| re-embed attempted outside `COMPLETED` (including while one is already running) | same compare-and-set matches no row → `409`; no second indexing starts |
| embedding fails during a re-embed | caught → meeting returns to `COMPLETED` with the error recorded; the previous chunks were never deleted, so retrieval is unaffected |
| database write fails mid-swap during indexing | the `DELETE` and the `INSERT`s share one transaction and roll back together; a half-replaced index cannot be committed |
| transcript edit attempted outside `REVIEW_REQUIRED` | `409` before any write |
| speaker rename attempted outside `REVIEW_REQUIRED` | the `EXISTS` predicate in the `UPDATE` matches nothing → `409`; approved transcripts are immutable |
| edit and approval arrive together | `edit_transcript` holds `SELECT … FOR UPDATE` on the meeting row; the two serialize — approve waits and indexes the edit, or approve wins and the edit gets `409` |
| segment edit names a speaker from another meeting | the correlated subquery yields NULL, `COALESCE` keeps the existing `speaker_id`; no cross-meeting write |
| any other pipeline exception | logged with traceback, `FAILED`, message truncated to 1000 chars |
| anonymous request | `require_login` returns `401` for `/api/*` and `303 → /login` for a page, before the route runs |
| forged or expired session cookie | the token is opaque and looked up in `auth_sessions` with an age predicate; no row means no user |
| another user's chat session id | every chat query filters on `user_id`, so it is a `404` — indistinguishable from one that never existed |
| retrieval returns nothing | `answer()` returns the "not found" message and an empty `sources` list; no LLM call |
| a scoped chat finds nothing | `scope_miss` is returned; the backend does **not** search wider. Only an explicit `global_override` request does, and it does not change the session scope |
| summary requested outside `COMPLETED` | `409` before the model is called |
| correction requested outside `REVIEW_REQUIRED` | `409` before the model is called |
| correction reply is not usable JSON | logged; an empty suggestion list is returned |
| correction names an unknown sequence, or does not change the text | dropped in `suggest_corrections`; it cannot reach the reviewer's editor |
| `OPENAI_API_KEY` unset | evidence returned with an explanatory answer; no LLM call |
| OpenAI call raises | caught and logged; evidence still returned with an explanatory answer |
| process restarts mid-analysis | the job is lost; `status` stays at whatever it last reached. No resume. |
| a migration statement fails | the whole file rolls back, no version is recorded, the runner exits non-zero; deployment stops before the application starts |
| the database is unmigrated at startup | `migrate.verify` raises `DB migration이 필요합니다.` and names the missing versions; the application refuses to start |
| vector dimension mismatch at startup | `migrate.verify` raises; the application refuses to start |
| a user is deactivated while logged in | `resolve_session` joins on `is_active`, so the existing cookie stops resolving on the next request |
| fact extraction fails or the model is unreachable | caught in `run_build` → `intelligence_state = FAILED` with the error; `meetings.status` is untouched, the previous facts are still there, and search keeps working |
| fact extraction runs at approval and indexing had failed | `claim` only matches a `COMPLETED` meeting, so the second background task does nothing |
| a fact cites a segment this meeting does not have | dropped in `_validate`; a fact left with no source at all is dropped with it, and the database `CHECK` refuses an empty `source_segment_ids` anyway |
| a fact names a speaker from another meeting | the role is dropped, the fact is kept — it was still said. `meeting_user_speakers` refuses the same thing with a composite foreign key |
| a deadline expression states no year, or has no single reading | `deadline_text` is stored as spoken and `deadline_at` stays NULL; no date is invented |
| the meeting never stated whether something is finished | `status = UNKNOWN`, not `OPEN`; the evidence says 미확인 and the answer must not call it incomplete |
| `held_at` is not set | ordering and deadline resolution fall back to `created_at`, deterministically, and the rendered date is labelled `등록` |
| two windows extract the same fact | `_dedupe` keys on (type, source segments) and (type, wording); it is stored once |
| a rebuild is requested while one is running | `claim`'s compare-and-set matches no row → `409` |
| the query planner fails or returns something unusable | `rag.plan` falls back to the question as typed with no filters — the dense-retrieval behaviour this had before |
| "내가 …" asked by an account with no speaker mapping | `rag.NO_IDENTITY` and no sources; the answer says to set it, and no requester is guessed |
| a chat scope names a deleted or nonexistent meeting | `= ANY(scope)` simply matches nothing there; the scope narrows and never widens |

## Deployment shape

`Dockerfile` has two stages.

```
node:22-slim  (stage "web")          python:3.11-slim  (runtime)
  npm ci                               ffmpeg, libgomp1
  npm run build  ── frontend/dist ──►  pip install -r requirements.txt
                                       app/, scripts/, frontend/dist
                                       uvicorn app.main:app
```

Node exists only in the first stage. The runtime image gets `frontend/dist` and
nothing else from it: no node, no npm, no `node_modules`, no frontend source.

`npm ci` reads the host CA bundle through a BuildKit secret
(`--mount=type=secret,id=ca_bundle`), because a TLS-inspecting proxy re-signs the
registry chain and Node ignores the system store. It is optional — where nothing
intercepts, the file is absent and npm uses its own roots — and it is never
written into a layer. `compose.yaml` declares it under `secrets:`, pointing at
the same `/etc/ssl/certs/ca-certificates.crt` it already mounts at runtime for
the Python side.

The runtime stage sets `HF_HOME=/models` and the CA-bundle environment variables
so a mounted host trust store is honoured. `compose.yaml` runs that single
service, maps `18080:8000`, and mounts the `models` and `uploads` volumes plus
the host CA bundle read-only. No database service is defined, and no frontend
service either.
