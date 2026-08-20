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

It is not a general transcription service, not a meeting scheduler, not a
note-taking editor, and has no notion of users, teams, or permissions.

## Architecture boundary

- A single FastAPI process serves the HTML UI, the JSON API, and runs the
  analysis pipeline. There is no separate worker process.
- Analysis runs on `fastapi.BackgroundTasks`, in-process.
- Database access is raw SQL through psycopg 3. There is no ORM and no
  repository/DAO layer.
- The frontend is Jinja2 templates plus one hand-written `app/static/app.js`.
  There is no build step, no bundler, no `package.json`.
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
- Re-running the pipeline for a meeting deletes and rewrites that meeting's
  `speakers` and `transcript_segments` rows, which discards any renames.

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
- Chunk content is stored as rendered `화자 A: …` lines, so the evidence text is
  readable on its own.
- The prompt restricts the model to the supplied evidence and requires it to say
  it found nothing rather than guess. Do not loosen that.
- Retrieval failure and answer-generation failure are distinct. When the LLM call
  fails, the evidence is still returned.

## Database boundary

- The application owns exactly one schema: `minutes` (`DATABASE_SCHEMA`).
- Tables: `meetings`, `speakers`, `transcript_segments`, `chunks`.
- **Never issue DDL or DML against any other schema in this database.** The
  instance is shared — `didim_rag` and other application schemas live beside
  `minutes` and are out of bounds.
- The one database-wide statement is `CREATE EXTENSION IF NOT EXISTS vector`.
  It only adds; it is the only permitted global effect.
- Schema is applied from `scripts/init_db.sql` at application startup
  (`app/main.py` lifespan → `app/db.py:apply_schema`). The SQL must stay
  idempotent — re-running it is normal, not exceptional.
- The embedding model's dimension is the source of truth for the vector column.
  `apply_schema` refuses to start if the existing column disagrees.
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
| OpenAI | answer generation from retrieved evidence only |

Whisper does not determine speakers. pyannote does not produce text. The OpenAI
call is never a retrieval step and never a source of facts.

## UI boundary

- Three pages: meeting list + upload (`/`), meeting detail (`/meetings/{id}`),
  chat (`/chat`). Each template calls one `init*()` function in
  `app/static/app.js`.
- Progress is observed by polling `GET /api/meetings/{id}/status` and
  `GET /api/meetings/{id}`. There is no SSE and no WebSocket.
- All values interpolated into the DOM go through `escapeHtml`.
- There is no authentication, no login, no session, and no admin view.

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
- **`error_message` is overloaded.** On `COMPLETED` it may carry a
  diarization-fallback *warning*, not an error (`app/services/pipeline.py`), and
  the UI renders it in the error style.
- **Speaker renames are not preserved** across a re-run of the pipeline.
- **Diarization has never run end-to-end.** The pyannote model is gated and the
  available `HF_TOKEN` has not accepted its licence, so every observed run took
  the single-speaker fallback path.
- **Answer generation has never run end-to-end.** The available
  `OPENAI_API_KEY` returns `invalid_organization`; only the retrieval half is
  verified.
- **Retrieval is dense-only.** Exact keyword, proper-noun, and numeric matching
  are weak.
- **CPU inference in the current environment.** The local GPU driver (CUDA 12.6)
  is older than the installed torch build and has insufficient free VRAM.

## Planned, not current

Not implemented. Do not document these as existing behaviour.

- **HITL Transcript Review Gate** — human review of the transcript before it is
  chunked, embedded, and indexed. Today `app/services/pipeline.py` runs
  transcription through indexing with no pause.
- Durable queue and a separate GPU worker process.
- Object storage for uploaded audio.
- Hybrid lexical + dense retrieval, and reranking.
- NCP deployment.
