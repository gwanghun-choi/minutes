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

- A single FastAPI process serves the HTML UI, the JSON API, and runs the
  analysis pipeline. There is no separate worker process.
- Analysis runs on `fastapi.BackgroundTasks`, in-process.
- Database access is raw SQL through psycopg 3. There is no ORM and no
  repository/DAO layer.
- The frontend is Jinja2 templates plus one hand-written `app/static/app.js`.
  There is no build step, no bundler, no `package.json`.
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

An answer without traceable evidence is a defect. Every retrieved chunk carries,
and every API response must keep:

| field | source |
|---|---|
| `meeting_id`, `meeting_title` | `meetings` |
| `speakers` | `chunks.speaker_codes` resolved through `speakers.display_name` |
| `start_time`, `end_time`, `time_label` | `chunks` |
| `text` | `chunks.content`, verbatim transcript |
| `score` | cosine similarity |

- `app/services/rag.py:serialize_sources` is the single place that shapes this.
  Do not build a second serializer.
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
  `meeting_summaries`, `users`, `auth_sessions`, `chat_sessions`,
  `chat_messages`, `schema_migrations`.
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
| OpenAI | answer generation from retrieved evidence; meeting summary and STT correction suggestions from the stored transcript |

Whisper does not determine speakers. pyannote does not produce text. The OpenAI
call is never a retrieval step and never a source of facts.

`services/assist.py` is the whole-transcript direction: it reads the meeting and
writes a summary, or proposes corrections. It never writes `transcript_segments`
and never changes `meetings.status`.

## UI boundary

- Four pages: login (`/login`), meeting list + upload (`/`), meeting detail
  (`/meetings/{id}`), chat (`/chat`). Each template calls one `init*()` function
  in `app/static/app.js`.
- The meeting detail page doubles as the review screen: at `REVIEW_REQUIRED` its
  transcript rows become editable and an approval panel appears. There is no
  separate review page.
- Progress is observed by polling `GET /api/meetings/{id}/status` and
  `GET /api/meetings/{id}`. There is no SSE and no WebSocket.
- All values interpolated into the DOM go through `escapeHtml`.
- The chat page is a sidebar of past chats plus one conversation. The meeting
  scope is chosen in a hand-written modal, not a `<select>`; a `<select>` stops
  being usable as meetings accumulate.
- Speaker colour is decoration. The display name is always rendered next to it,
  so colour is never the only way to tell speakers apart.
- There is no admin view and no user administration.

## Identity and chat invariant

The login is an identity boundary, not an authorization system.

- `app/main.py:require_login` runs before every route. Only `/health`, `/login`,
  `POST /api/auth/login`, and `/static/*` are public. An anonymous API call is a
  `401` and an anonymous page is a redirect. **Never rely on the UI hiding a
  control.**
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
- `last_login_at` is written on a successful login only. A failed attempt must
  leave it untouched.
- **Every chat query filters on `user_id`.** Another user's session id is a
  `404`, never a `403` and never their data. This is the only ownership rule in
  the system; meetings deliberately have none.

## Chat scope invariant

**A chat that names the meetings to search is never widened by the backend.**

- `chat_sessions.scope_meeting_ids` is the scope. Empty means the whole corpus;
  a non-empty array is a hard restriction applied in `rag.search` as
  `c.meeting_id = ANY(...)`.
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
  are weak.
- **A follow-up question is retrieved on its own words.** Conversation history
  reaches the answer generator but not the embedder, so "그 부서는?" retrieves on
  those words alone. Rewriting the query would be a second LLM call and a change
  to retrieval semantics.
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
