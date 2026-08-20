# Current architecture

Snapshot of what the source actually does, as of 2026-08-20.
Boundaries and rules live in [AGENTS.md](../../AGENTS.md); this file describes structure.

## Runtime components

| component | where it runs | notes |
|---|---|---|
| FastAPI application | one process, `uvicorn app.main:app` | serves HTML, JSON API, and the analysis pipeline |
| PostgreSQL 16 + pgvector | external, pre-existing instance | shared with other applications; `minutes` schema only |
| FFmpeg | subprocess | system binary, or the `imageio-ffmpeg` static build |
| faster-whisper | in-process | CTranslate2, model cached under `HF_HOME` |
| pyannote.audio | in-process | gated model, needs `HF_TOKEN` |
| BGE-M3 (sentence-transformers) | in-process | 1024-dim |
| OpenAI Chat Completions | network call | answer generation only |
| Browser UI | client | Jinja2-rendered HTML + one vanilla JS file |

There is no worker process, no queue, and no database container.

## Application module map

```
app/
├── main.py                  FastAPI app, lifespan (schema + pool), page routes, /health
├── config.py                env → module constants; resolve_device(); ALLOWED_EXT
├── db.py                    psycopg pool, conn(), apply_schema() + dimension guard
├── api/
│   ├── meetings.py          POST/GET meetings, GET status, PATCH transcript,
│   │                        POST approve, PATCH speaker name
│   └── chat.py              POST /api/chat
├── services/
│   ├── pipeline.py          process() — analysis, stops at the review gate;
│   │                        index_transcript() — post-approval indexing;
│   │                        load_transcript(), _persist_transcript()
│   ├── audio.py             ffmpeg_bin(), to_wav16k(), duration_seconds()
│   ├── transcription.py     faster-whisper, cached model
│   ├── diarization.py       pyannote, cached pipeline
│   ├── transcript.py        assign_speakers() — overlap join
│   ├── chunking.py          build_chunks() — utterance-aware
│   ├── embedding.py         cached model, dimension(), encode(), encode_one()
│   └── rag.py               search(), build_context(), answer(), serialize_sources()
├── templates/               base, index, meeting, chat
└── static/                  app.css, app.js

scripts/init_db.sql          idempotent DDL, applied at startup
tests/test_core.py           6 unit tests, no model or DB access
tests/test_hitl.py           11 tests over the approval gate; real DB, faked embeddings
```

Dependencies point one way: `api/` → `services/` → `db.py` → PostgreSQL.
`services/` modules do not import each other except through `pipeline.py`, which
is the only orchestrator.

## Startup sequence

`app/main.py` lifespan, in order:

1. `embedding.dimension()` — loads BGE-M3 and reads its dimension. This is the
   first network/disk cost and dominates cold start.
2. `db.apply_schema(dim)` — runs `scripts/init_db.sql` on a standalone
   autocommit connection, then verifies `chunks.embedding` matches `dim` and
   raises if not.
3. `db.init_pool()` — opens the pool. Each connection sets `search_path` to the
   schema and registers the pgvector type.

Order matters: the pool cannot register the `vector` type before
`CREATE EXTENSION` has run, so DDL must precede the pool.

## Data flow

```
Browser
  │  POST /api/meetings  (multipart: file, title)
  ▼
api/meetings.py  ── extension check ──► reject 400
  │  write UUID-named file to UPLOAD_DIR
  │  INSERT meetings (status='UPLOADED')
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
   DELETE+INSERT chunks (with embedding)
        │  status=COMPLETED
        │  (on failure: back to REVIEW_REQUIRED, transcript preserved)
        ▼
   PostgreSQL / pgvector


Browser
  │  POST /api/chat  {question, meeting_id|null, top_k}
  ▼
rag.answer
  ├─ embedding.encode_one(question)
  ├─ SELECT … WHERE m.status = 'COMPLETED'           (approved meetings only)
  │            ORDER BY embedding <=> query LIMIT k   (optional meeting_id filter)
  ├─ resolve speaker_codes → display_name per meeting
  ├─ build_context  ──► numbered evidence blocks
  ├─ OpenAI chat completion (evidence-only prompt)
  └─ serialize_sources ──► {answer, sources[]}
```

The list and detail pages poll (`3000 ms` / `2000 ms`) to observe `status`.

## Persistence

| data | location | lifetime |
|---|---|---|
| uploaded audio (`<uuid>.<ext>`) | `UPLOAD_DIR` = `data/uploads`; `uploads` volume in Docker | until manually removed |
| normalized audio (`<uuid>.16k.wav`) | same directory | same; `to_wav16k` reuses it if present |
| meetings / speakers / transcript_segments / chunks | PostgreSQL schema `minutes` | until deleted |
| embeddings | `chunks.embedding vector(1024)`, HNSW cosine index | with the chunk |
| model weights | `HF_HOME=/models`, `TORCH_HOME=/models/torch`; `models` volume in Docker | until the volume is removed |
| analysis progress | `meetings.status` column only | no job table, no queue |

`transcript_segments` is rewritten per analysis run and edited in place during
review; `speakers` is upserted so reviewer renames survive; `chunks` is deleted
and rebuilt on every approval.

## Database schema

Defined in `scripts/init_db.sql`, applied at startup.

- `meetings` — `id`, `title`, `original_filename`, `stored_filename`, `duration`,
  `language`, `status`, `error_message`, `created_at`
- `speakers` — `id`, `meeting_id` FK cascade, `speaker_code`, `display_name`;
  `UNIQUE (meeting_id, speaker_code)`
- `transcript_segments` — `id`, `meeting_id` FK cascade, `speaker_id` FK set-null,
  `sequence`, `start_time`, `end_time`, `text`; index on `(meeting_id, sequence)`
- `chunks` — `id`, `meeting_id` FK cascade, `sequence`, `content`, `start_time`,
  `end_time`, `speaker_codes TEXT[]`, `embedding vector(1024)`;
  index on `meeting_id`, HNSW `vector_cosine_ops` on `embedding`

`CREATE EXTENSION IF NOT EXISTS vector` is the only database-wide statement.

## Status values

```
UPLOADED → TRANSCRIBING → DIARIZING → REVIEW_REQUIRED → INDEXING → COMPLETED
                     │                       ▲                │
                     └──► FAILED             └────────────────┘
                                              indexing failure
```

`REVIEW_REQUIRED` is the human approval gate; `COMPLETED` means approved and
indexed. Written by `pipeline.set_status`, except the approval transition, which
is an atomic `UPDATE … WHERE status = 'REVIEW_REQUIRED'` in
`api/meetings.py:approve_meeting` so that a repeated approval cannot index twice.

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
| approval attempted outside `REVIEW_REQUIRED` | atomic `UPDATE` matches no row → `409`; no indexing starts |
| transcript edit attempted outside `REVIEW_REQUIRED` | `409` before any write |
| speaker rename attempted outside `REVIEW_REQUIRED` | the `EXISTS` predicate in the `UPDATE` matches nothing → `409`; approved transcripts are immutable |
| edit and approval arrive together | `edit_transcript` holds `SELECT … FOR UPDATE` on the meeting row; the two serialize — approve waits and indexes the edit, or approve wins and the edit gets `409` |
| segment edit names a speaker from another meeting | the correlated subquery yields NULL, `COALESCE` keeps the existing `speaker_id`; no cross-meeting write |
| any other pipeline exception | logged with traceback, `FAILED`, message truncated to 1000 chars |
| retrieval returns nothing | `answer()` returns the "not found" message and an empty `sources` list; no LLM call |
| `OPENAI_API_KEY` unset | evidence returned with an explanatory answer; no LLM call |
| OpenAI call raises | caught and logged; evidence still returned with an explanatory answer |
| process restarts mid-analysis | the job is lost; `status` stays at whatever it last reached. No resume. |
| vector dimension mismatch at startup | `apply_schema` raises; the application refuses to start |

## Deployment shape

`Dockerfile` builds one image on `python:3.11-slim` with `ffmpeg` and `libgomp1`
installed, `HF_HOME=/models`, and the CA-bundle environment variables set so a
mounted host trust store is honoured. `compose.yaml` runs that single service,
maps `18080:8000`, and mounts the `models` and `uploads` volumes plus the host CA
bundle read-only. No database service is defined.
