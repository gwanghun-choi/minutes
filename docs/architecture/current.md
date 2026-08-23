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
│   ├── meetings.py          POST meetings (owner = the session), GET meetings
│   │                        (one page: _narrow + COUNT + LIMIT/OFFSET, access
│   │                        predicate first, ?scope=mine|shared), GET one
│   │                        (?version=, role, draft_version), GET status,
│   │                        DELETE meeting (owner, any status),
│   │                        PATCH transcript (owner, before approval only),
│   │                        POST approve (the one publish; a second is 409),
│   │                        POST reindex, PATCH speaker name, GET/POST summary,
│   │                        POST corrections, PUT me (user↔speaker),
│   │                        PUT held-at, PUT category + PUT alias (personal
│   │                        filing — read access, never the meeting),
│   │                        GET intelligence, POST intelligence/rebuild.
│   │                        _editable_draft() is the immutability gate
│   ├── versions.py          GET /meetings/{id}/versions and GET one version's
│   │                        transcript. Read-only: approved minutes are
│   │                        immutable, so there is no POST and no DELETE
│   ├── shares.py            owner side: GET/POST/DELETE /meetings/{id}/shares.
│   │                        invited side: GET /share-invitations,
│   │                        POST accept / reject
│   ├── users.py             GET /users?q= — the invite picker's search. Answers
│   │                        a search, never a browse
│   ├── categories.py        this account's tree only: GET (organization.TREE:
│   │                        recursive CTE → path, depth, counts), POST,
│   │                        PATCH name, PUT parent (cycle-checked through
│   │                        SUBTREE), DELETE one (refused while it has
│   │                        children; clears filings and chats first)
│   └── chat.py              chat session CRUD, PATCH category, POST session
│                            messages; _retitle() shows evidence under this
│                            account's alias
├── services/
│   ├── access.py            READABLE — the one access predicate, pasted into
│   │                        every meeting query; role(), require_read(),
│   │                        require_owner(), visible()
│   ├── organization.py      the personal layer: FILING / DISPLAY_TITLE /
│   │                        COLUMNS (joined into every meeting-shaped
│   │                        response), SUBTREE and TREE over user_categories,
│   │                        owned(), file_meeting(), aliases()
│   ├── versions.py          which revision is published: published(),
│   │                        open_version(), current(), start(), claim(),
│   │                        publish() (inside the indexing transaction),
│   │                        release(), history(). Nothing here starts a second
│   │                        revision — approved minutes are immutable
│   ├── pipeline.py          process() — analysis, stops at the review gate;
│   │                        index_transcript() — indexes one version and
│   │                        publishes it in the same transaction, also re-run by
│   │                        reindex; load_transcript(),
│   │                        _persist_transcript(); set_status() reports whether
│   │                        the meeting still exists, and _abandon() drops the
│   │                        audio when it was deleted mid-analysis
│   ├── audio.py             ffmpeg_bin(), meeting_files(), to_wav16k(),
│   │                        duration_seconds()
│   ├── transcription.py     faster-whisper, cached model
│   ├── diarization.py       pyannote, cached pipeline
│   ├── transcript.py        assign_speakers() — overlap join
│   ├── chunking.py          build_chunks() — utterance-aware, carries the
│   │                        source segment ids of every chunk
│   ├── embedding.py         cached model, dimension(), encode(), encode_one()
│   ├── lexical.py           Kiwi: tokens(), lexemes(), tsquery(). KEEP_TAGS,
│   │                        STOPWORDS. Produces an index, never content
│   ├── fusion.py            fuse() — RRF over two rankings; meta_hits();
│   │                        CANDIDATES, RRF_K, META_BOOST, TITLE_MATCH, MODES
│   ├── auth.py              scrypt hashing, opaque sessions, is_active enforcement
│   ├── assist.py            summarize(), suggest_corrections() — whole-transcript
│   │                        OpenAI calls; neither writes to the transcript
│   ├── intelligence.py      build() — approved transcript → validated facts;
│   │                        store() — the only fact writer; claim(),
│   │                        run_build(), after_approval(); search_dense(),
│   │                        search_lexical(), search(), my_speakers();
│   │                        deadline_date()
│   └── rag.py               plan(), search_dense(), search_lexical(), search(),
│                            build_context(), has_conflict(),
│                            validate_citations(), answer(),
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
│   │   │                    CategoryNav (mounted in AppShell),
│   │   │                    PendingNotice, SpeakerBar, TranscriptPanel,
│   │   │                    CorrectionPanel, SummaryPanel, IntelligencePanel,
│   │   │                    FactCard, DangerZone
│   │   └── chat/            ChatNav (mounted in AppShell), canvas.ts (CANVAS),
│   │                        Conversation, Composer, ScopeDialog, SourceDrawer
│   └── test/                Vitest suites + the fetch-stub harness
└── e2e/                     Playwright browser smoke over the production build

scripts/migrate.py           migration runner: run(), verify(). The only DDL path.
scripts/migrations/*.sql     001_initial, 002_productization, 003_user_identity,
                             004_meeting_intelligence, 005_meeting_held_at,
                             006_meeting_categories, 007_lexical_retrieval,
                             008_category_hierarchy,
                             009_meeting_ownership_sharing_versions,
                             010_uat_second_account, 011_personal_organization
scripts/backfill_lexemes.py  builds `lexemes` for rows that already have a
                             vector. Never loads BGE-M3 and never calls an LLM
scripts/evaluate.py          retrieval evaluation in a throwaway `minutes_eval`
                             schema: Hit@K, MRR, per-type breakdown, latency,
                             constant sweeps, chunk-shape diagnostics
scripts/eval_data.py         the corpus and the 44 questions, with the answering
                             meeting and utterance ids written down
tests/conftest.py            DB detection, migration run, fake embeddings, fake
                             fact extraction, throwaway accounts and meetings,
                             logged-in clients
tests/test_core.py           8 unit tests, no model or DB access
tests/test_migrate.py        20 tests over the runner, using throwaway schemas
tests/test_hitl.py           23 tests over the approval gate, re-embedding, and
                             deletion; real DB, faked embeddings
tests/test_auth.py           16 tests over the identity boundary
tests/test_chat.py           24 tests over chat ownership, multi-turn, scope, and
                             renaming
tests/test_assist.py         12 tests over summary and correction suggestions
tests/test_intelligence.py   52 tests over fact extraction, validation, rebuild
                             atomicity, and the user↔speaker mapping
tests/test_retrieval.py      22 tests over relationship, temporal, and follow-up
                             retrieval through the chat API
tests/test_hybrid.py         50 tests over Korean lexemes, RRF fusion, metadata
                             agreement, citation validation, conflict detection,
                             the scope invariant on all four retrieval paths, and
                             lexical backfill
tests/test_frontend.py       13 checks on SPA/API route priority, deep links,
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

`fusion.py` sits below both retrieval layers and above neither: it imports only
`lexical` and touches no database. It exists so a chunk ranking and a fact
ranking cannot drift apart — `rag.py` cannot import `intelligence.py`'s copy of
the fusion rule and `intelligence.py` cannot import `rag.py` at all.

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
  │  INSERT meetings (status='UPLOADED', held_at,
  │                   owner_user_id = request.state.user, never from the body)
  │  INSERT meeting_versions (version 1, DRAFT) in the same transaction
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
   chunking.build_chunks ──► [{sequence, content, start_time, end_time,
        │                        speaker_codes, source_segment_ids}]
        ▼
   embedding.encode ──► 1024-dim normalized vectors
   lexical.lexemes  ──► Kiwi morphemes, one string per chunk
        ▼
   DELETE+INSERT chunks (embedding AND lexemes in the same statement, so the
        │                two indexes cannot describe different text; lexeme_tsv
        │                is generated by PostgreSQL from lexemes)
        │                                        ← one transaction
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
  │    └─ participant_role REQUESTER / ASSIGNEE / DECIDER / null
  │       any failure (no key, bad JSON, unknown enum) → the question as typed
  ├─ rag.is_self_scoped(question)     NOT part of the LLM call
  │    an explicit first-person form in the question as typed (rag.SELF_FORMS,
  │    with a lookbehind so 내용 / 안내 / 결제 are not first person). Only this
  │    requires a user↔speaker mapping; a general question never does, and the
  │    same question is always judged the same way
  ├─ intelligence.search(plan.query, scope, …)        structured layer
  │    ├─ search_dense    ORDER BY f.embedding <=> query      LIMIT 30
  │    ├─ search_lexical  ORDER BY ts_rank_cd(f.lexeme_tsv, q) LIMIT 30
  │    │  both through intelligence._fact_rows, so these predicates are one
  │    │  piece of text: m.status = 'COMPLETED'
  │    │                 AND f.meeting_id = ANY(scope)   (only when scope is set)
  │    │                 AND f.fact_type = ANY(types)
  │    │                 AND EXISTS (participant with that role / that speaker)
  │    ├─ _label_facts    participants and the meeting's date, before fusion —
  │    │                  the metadata signal needs the speaker names
  │    ├─ fusion.fuse     RRF, then metadata agreement, then Top-K 6
  │    └─ re-sorted by (coalesce(m.held_at, m.created_at), start_time) —
  │       chronological by when the meetings were held, not when they were
  │       uploaded. Retrieval decides which facts; this decides reading order
  ├─ rag.search(plan.query, scope, …)                  excerpt layer
  │    ├─ search_dense    ORDER BY c.embedding <=> query       LIMIT 30
  │    ├─ search_lexical  ORDER BY ts_rank_cd(c.lexeme_tsv, q) LIMIT 30
  │    │  both through rag._chunk_rows, same two predicates
  │    │  a question with no lexemes ("그거 언제까지야?") returns [] on the
  │    │  lexical axis and is carried entirely by the dense one
  │    └─ fusion.fuse     RRF, then metadata agreement, then Top-K 6
  │    skipped entirely when the question is self-scoped: a chunk carries no participant
  │    filter, so it could show somebody else's request as if it were mine
  ├─ sources = facts + chunks         facts first, each with its source segments
  ├─ build_context  ──► numbered evidence blocks
  ├─ has_conflict(sources)            same role, different person, different
  │                                   meeting, overlapping subject → append
  │                                   CONFLICT_NOTE after the evidence, before
  │                                   the question
  ├─ OpenAI chat completion (system + prior turns + evidence-only prompt,
  │                          the question exactly as the user typed it)
  ├─ validate_citations               a [N] outside 1..len(sources) is dropped;
  │                                   the sentence itself is never rewritten
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
        ├─ prose on the CANVAS axis, left-aligned, with no card and no border —
        │  the answer is the page's content, so a two-line reply looks like two
        │  lines. The question above it is a compact right-aligned bubble.
        ├─ the answer's `[N]` markers, each a button that opens that source
        └─ SourceTrigger  closed by default: one toggle, "출처 N개"
              opened → SourceDrawer, off-canvas from the right (full width below
                       `sm`), always mounted and moved by `translate-x` so the
                       conversation never reflows; `inert` + `aria-hidden` while
                       closed. Every source in `sources[]`, full transcript text,
                       a link to the meeting and to the position in its
                       transcript (`?tab=transcript&at=`), and no similarity
                       score, chunk id, or fact id on screen.
```

The button's count is what the answer **cited** — the `[N]` markers in its own
text — because retrieval sends a fixed number of candidates and the model quotes
the ones it used; "출처 6개" on an answer resting on two describes the search,
not the answer. When it cited nothing the label says 검색 결과 N개 instead.

The drawer still holds the whole retrieved set, and says how many of it the
answer did not quote. Nothing between `rag.serialize_sources` and this component
removes a source; `chat_messages.sources` holds the same list, so reopening the
conversation reproduces the same evidence.

### Sharing a meeting

```
Owner                                        Invited account
  │  GET /api/users?q=최          (search, never a browse)
  │  POST /meetings/{id}/shares {user_id}
  │        └─ 409 unless the meeting is COMPLETED
  │        └─ CHECK refuses inviting yourself
  │        └─ UNIQUE refuses a duplicate
  │                                            │  GET /share-invitations
  │                                            │  POST /{share_id}/accept
  │                                            ▼
  │                                     access.READABLE now matches:
  │                                     list, detail, transcript, versions,
  │                                     intelligence, and all four retrieval
  │                                     paths, on the very next request
  │  DELETE /meetings/{id}/shares/{user_id}
  │        └─ status=REVOKED, revoked_at=now()
  │                                            ▼
  │                                     the same six doors close again;
  │                                     stored chat sources lose their text
```

Nothing caches the predicate, which is what makes both directions immediate.

### Correcting minutes, and why only once

```
업로드 → STT → 화자 분리 → REVIEW_REQUIRED
                              │  PATCH /transcript        the one editing window
                              │  PATCH /speakers/{id}
                              │  POST  /corrections       (suggests, writes nothing)
                              ▼
                           POST /approve
                              ├─ embed v1's chunks           (outside any transaction)
                              ├─ BEGIN
                              │    DELETE chunks WHERE meeting_id
                              │    INSERT v1's chunks
                              │    v1 → PUBLISHED
                              │    meetings.status → COMPLETED
                              │  COMMIT
                              └─ on any failure: back to REVIEW_REQUIRED, nothing indexed
                              ▼
                           COMPLETED ── every write above is now 409
```

`app/api/meetings.py:_editable_draft` is the single gate. It returns a version
only for a `DRAFT` on a `REVIEW_REQUIRED` meeting, and the transcript PATCH, the
speaker rename, the correction suggestions, and the approval itself all call it
— so a request made directly against the API is refused by the same condition
the screen was drawn from. There is no endpoint that starts a revision: `POST`
and `DELETE` on `/versions` do not exist.

The cost is stated rather than worked around: a transcript found to be wrong
after approval can only be replaced by uploading the audio again. What that buys
is that every chunk, every fact, every stored citation, and every shared
reader's answer rests on words that do not move.

`meeting_versions` and the per-version `transcript_segments` stay as read-only
provenance. A database that ran an earlier build may hold a v2, or a stranded
`DRAFT`; both are readable through `GET /versions` and `?version=`, the meeting
reports no editable revision, and neither can be resumed or approved.

### Filing: canonical meeting, personal arrangement

```
                     meetings                       user_meeting_filing
                     ────────                       ───────────────────
   owner  ─────────► title, held_at, transcript,  ◄── (owner,   meeting) category, alias
                     speakers, status, provenance ◄── (reader,  meeting) category, alias
   reader ─ read ───►                                 one row each, invisible to the other
```

A meeting is one recording with one owner. How it is filed and what it is called
on one person's screen is not part of it — that is one row per (account,
meeting), so the owner's 업무 / 구매부 and the reader's 면접준비 / 사례
"정산 프로세스 참고" are both true at once and neither is visible to the other.

- `organization.FILING` is the LEFT JOIN, `organization.COLUMNS` the selected
  columns, and `display_title` is `coalesce(uf.alias, m.title)` — resolved per
  request, so `meetings.title` never changes and clearing an alias returns to it
  rather than to a stale copy.
- `PUT /category` and `PUT /alias` take **read** access. A shared reader
  arranging their own list is not editing somebody's minutes.
- Organisation is never permission. A filing row is not a reason to show a
  meeting and its absence is not a reason to hide one; after a revoke the row
  survives, the folder counts zero, and every door still answers `404`.
- Cross-account filing is refused by the database: every reference to a category
  is a composite foreign key carrying `user_id`
  (`user_categories.parent_id`, `user_meeting_filing.category_id`,
  `chat_sessions.category_id`).
- Stored chat evidence is retitled on read (`chat.py:_retitle`), so an alias set
  today renames the evidence in yesterday's answer, and the stored payload keeps
  the canonical title it was retrieved with.

### Category management

The sidebar tree (`features/meetings/CategoryNav.tsx`) is the only place a
category is created, renamed, moved, or deleted — `[+]` for a new one, each
row's `⋯` for the rest. There used to be a `/categories` page, which meant
leaving the list to organise the list; it is gone. The tree also navigates, by
writing `?category=` on the meeting list, and expanding a category lists a few
recent meetings and then 전체 보기 rather than every meeting it holds.

All of it uses `useCategoryMutations`, whose invalidation refetches the category
list and the meeting list together — a rename or a move changes what every
meeting row displays. Deleting removes the folder and nothing that was in it:
the filings and conversations are cleared to NULL in the same transaction (which
is why those foreign keys are `RESTRICT`), so an alias set beside a category
survives the category going. A category with children is refused entirely, and
`ON DELETE RESTRICT` refuses it even if the request is made directly.

The tree itself is the database's: one recursive CTE returns `parent_id`,
`path` ("업무 / 개발"), `depth`, the meeting count *this account may read*, the
chat count, and the child count, in path order, so every screen renders the same
hierarchy without rebuilding it. Selecting a parent on the list filters on
`organization.SUBTREE`, the same recursive walk that refuses a cycle when a
category is moved.

### An invitation is a notification

`features/meetings/InvitationBell.tsx` is a count in the sidebar and a dialog
over whatever screen the reader was on. It was a route with a page of its own,
which put a destination in the navigation that is empty almost all of the time.
The dialog shows a title, a date, and who sent it — which is exactly what an
invitation grants, because until it is accepted the meeting is unreachable.

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
cascades to every child table, then both files named by `stored_filename` are
unlinked. Database first — a failed unlink leaves an unreferenced file, whereas
the other order would leave a row pointing at audio that is gone.

There is no status gate on it, and every screen uses this one endpoint. A
meeting can therefore be deleted while a background task is working on it, which
is deliberate: in-process tasks do not survive a restart, so a row left at
`DIARIZING` has nothing behind it and no other way out. What keeps that safe is
the task side. Every write names the meeting by id, so a foreign key refuses it
once the row is gone; `pipeline.set_status` reports a missing row, and
`pipeline.process` checks for one before persisting a transcript and calls
`_abandon` to remove the audio it was still holding. Nothing cancels a running
STT or diarization — the task finishes into nothing.

## Database schema

Defined in `scripts/migrations/`, applied by `python -m scripts.migrate`.

- `meetings` — `id`, `title`, `original_filename`, `stored_filename`, `duration`,
  `language`, `status`, `error_message`, `held_at` (nullable — when the meeting
  actually took place), `category_id` (**legacy**: the global filing, unread
  since `011`),
  `owner_user_id` (nullable FK to `users`, set-null — NULL is an orphan nobody
  may read), `created_at` (when it was uploaded); index on `owner_user_id`
- `speakers` — `id`, `meeting_id` FK cascade, `speaker_code`, `display_name`;
  `UNIQUE (meeting_id, speaker_code)`
- `transcript_segments` — `id`, `meeting_id` FK cascade, `speaker_id` FK set-null,
  `version` (default 1), `sequence`, `start_time`, `end_time`, `text`; index on
  `(meeting_id, sequence)`, `UNIQUE (meeting_id, version, sequence)`
- `chunks` — `id`, `meeting_id` FK cascade, `version`, `sequence`, `content`,
  `start_time`, `end_time`, `speaker_codes TEXT[]`, `embedding vector(1024)`;
  index on `meeting_id`, HNSW `vector_cosine_ops` on `embedding`.
  Only the published version's chunks exist at any moment.
- `meeting_versions` — `(meeting_id, version)` PK, `status`
  (DRAFT/INDEXING/PUBLISHED/SUPERSEDED), `created_by_user_id` FK set-null,
  `created_at`, `published_at`; partial `UNIQUE (meeting_id)` where PUBLISHED and
  another where status is DRAFT or INDEXING. One version per meeting in practice:
  approved minutes are immutable, so nothing creates a second. Kept as read-only
  provenance for the ones an earlier build may have left.
- `meeting_shares` — `id`, `meeting_id` FK cascade, `invited_user_id` FK cascade,
  `invited_by_user_id` FK cascade, `status`
  (PENDING/ACCEPTED/REJECTED/REVOKED), `created_at`, `responded_at`,
  `revoked_at`; `UNIQUE (meeting_id, invited_user_id)`,
  `CHECK (invited_user_id <> invited_by_user_id)`, index on
  `(invited_user_id, status)`

- `schema_migrations` — `version` PK, `name`, `applied_at`
- `users` — `id` (internal BIGINT key), `username UNIQUE` (the login id),
  `password_hash`, `display_name`, `is_active`, `created_at`, `updated_at`,
  `last_login_at`
- `auth_sessions` — `id TEXT` (the cookie value), `user_id` FK cascade, `created_at`
- `chat_sessions` — `id`, `user_id` FK cascade, `title`, `scope_meeting_ids BIGINT[]`
  (empty = global), `category_id` (this account's own — see below), `created_at`,
  `updated_at`; indexes on `(user_id, updated_at DESC)` and `(user_id, category_id)`
- `chat_messages` — `id`, `session_id` FK cascade, `role` CHECK user/assistant,
  `content`, `sources JSONB`, `created_at`; index on `(session_id, id)`
- `meeting_summaries` — `meeting_id` PK and FK cascade, `content`, `created_at`

Personal organisation (`011`; `006` and `008` are its legacy source):

- `user_categories` — `id`, `user_id` FK cascade, `name`, `parent_id`,
  `created_at`, `updated_at`. `UNIQUE (user_id, name)` is the duplicate policy,
  narrowed to the account the tree belongs to: two people may both have a 업무,
  and neither may have two. `UNIQUE (user_id, id)` is what lets the references
  below carry `user_id`, and `(user_id, parent_id) → (user_id, id)` with
  `ON DELETE RESTRICT` is the whole "a parent never takes its children" rule.
  `CHECK (parent_id IS DISTINCT FROM id)` stops A → A; a longer cycle is refused
  by the recursive walk in `organization.py`. Index on `(user_id, parent_id)`.
- `user_meeting_filing` — `(user_id, meeting_id)` PK, both FK cascade,
  `category_id`, `alias`, `created_at`, `updated_at`; index on
  `(user_id, category_id)`. One row per account per meeting: that account's
  folder and its own name for it. A row with both fields NULL means the same as
  no row, which is what keeps "미분류, canonical title" the default with nothing
  stored. `(user_id, category_id) → user_categories (user_id, id)` carries
  `user_id` into the reference, so **the database refuses a filing that names
  another account's category**. `RESTRICT` rather than `SET NULL`: deleting a
  category clears the filings first, in the same transaction, so an alias
  survives the folder going.
- `chat_sessions.category_id` — the same guard, as a column: a conversation is
  already owned by one account, so its filing needs no second table.
- `meeting_categories` / `meetings.category_id` — the global tree from `006` and
  `008`. `011` copied each owner's filing into their own tree and the
  application stopped reading these; migrations here only add, so both remain.
  Nothing writes them.

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
indexed. Written by `pipeline.set_status`, except the transitions into
`INDEXING`, which are atomic compare-and-sets — inside `approve_meeting` for the
first approval and in `api/meetings.py:_claim_for_indexing` for a re-embed — so
that a repeated request cannot index twice.

Revising an already-approved meeting does **not** move this state machine at all.
`meetings.status` stays `COMPLETED` for the whole revision, because it is a
retrieval predicate; the revision runs on the version state machine instead:

```
DRAFT ──[승인]──► INDEXING ──[성공]──► PUBLISHED   (previous → SUPERSEDED)
  ▲                   └──[실패]────────┘
  └───────────────────────┘  previous version keeps serving throughout
```

`versions.claim` is the compare-and-set on the version row, and `versions.publish`
runs inside the same transaction that replaces the chunks.

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
| the query planner fails or returns something unusable | `rag.plan` falls back to the question as typed with no filters — the behaviour this had before query planning existed |
| a question has no searchable morphemes | the lexical axis returns `[]`, fusion falls through to the dense ranking alone, and nothing is logged as an error |
| a chunk or fact has `lexemes IS NULL` (indexed before migration 007) | it is invisible to the lexical axis and still found by the dense one. `python -m scripts.backfill_lexemes` fixes it without re-embedding |
| the model cites evidence that was never sent | `rag.validate_citations` removes the marker and logs it. The answer text is returned, minus the false provenance |
| two meetings answer the same question differently | detected from the retrieved rows, not asked of the model; both stay in the evidence and the prompt requires them to be presented separately |
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

### The network

PostgreSQL is a container too, but not one this file owns: it is its own compose
project, and the two meet on a Docker network that neither project creates.

```
minutes  ─┐
          ├── minutes-net   (external, created once per host)
minutes-postgres ─┘
```

```yaml
networks:
  default:
    external: true
    name: minutes-net
```

Overriding `default` rather than adding a second network is what makes this hold
for *every* container the file produces, including the one-off
`docker compose run --rm minutes python -m scripts.migrate`. Compose otherwise
invents an implicit per-project network — `minutes_default` — and a `run`
container lands there by itself, where `minutes-postgres` is not a name that
resolves. That failure looks like a database problem
(`Temporary failure in name resolution`) and is not one.

`external: true` means Compose will use the network but never create it, so it
must exist before the first `up`:

```bash
docker network inspect minutes-net >/dev/null 2>&1 || docker network create minutes-net
```

If it does not, Compose refuses to start rather than silently building an
isolated one. That refusal is the point: a deployment that works only because
some container was hand-attached to a network months ago is not reproducible
from this repository, which is the whole claim this file makes.
