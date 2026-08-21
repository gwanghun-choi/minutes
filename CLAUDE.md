# Working in this repository

## Read AGENTS.md first

[AGENTS.md](AGENTS.md) holds the invariants — what is true of `minutes` and what
must remain true. This file holds workflow — how to work here.

**Nothing in this file overrides anything in AGENTS.md.** Its MAIN RULE
(Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven
Execution) is the highest-priority principle in this repository and outranks
everything below, including Ponytail.

## Ponytail is the default posture

**Ponytail is the default posture. Default intensity: `full`.**

It applies to every application change unless the user turns it off. The MAIN
RULE says how to think; Ponytail says how that becomes the smallest working
implementation.

Climb the ladder and stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need → skip it, say so in one line.
2. **Is it already in this codebase?** `app/services/` is small enough to read.
   `rag.serialize_sources`, `rag._fmt_time`, `db.conn`,
   `config.resolve_device`, `lexical.lexemes`, `lexical.tsquery`, `fusion.fuse`,
   `fusion.meta_hits`, and `intelligence.store` already exist on the backend; `api/client.ts`,
   `api/queries.ts`, `lib/format.ts`, `lib/labels.ts`, `lib/meetings.ts`,
   `features/chat/canvas.ts`, `features/meetings/PendingNotice.tsx`, and
   `components/ui/*` (including `Menu.tsx`) already exist on the frontend —
   reuse them.
3. **Can Python's stdlib or PostgreSQL do it?** A foreign key, `UNIQUE`,
   `ON CONFLICT`, or an index beats application-side enforcement. `functools`,
   `pathlib`, `subprocess`, and `contextlib` are already in use.
4. **Can HTML/CSS or a native browser API do it?** `<input type="file">`,
   `fetch`, `FormData`, and `setInterval` already carry the UI.
5. **Does an installed dependency solve it?** Everything in `requirements.txt`
   is fair game. A new one is not.
6. **Can it be one line?** Then it is one line.
7. **Only then:** the minimum code that works.

> Ponytail is not a rule about reading less. It is a rule about writing less
> after reading enough. Trace the real flow first, then climb the ladder.

Never simplify away: input validation at trust boundaries, error handling that
prevents data loss, secret handling, or anything the user explicitly asked for.

### minutes-specific boundaries

These reflect the current architecture. Crossing one needs a real, stated reason
and a record in `docs/decisions/`.

**Backend.** FastAPI routers → `app/services/` → raw SQL in `app/db.py` is the
whole structure, and it is enough. Do not introduce an ORM, a repository or DAO
layer, a DI framework, or a generic service abstraction. Four tables and a
handful of queries do not need a persistence layer.

**AI orchestration.** `app/services/pipeline.py:process` is a linear function
that calls each stage in order. That *is* the orchestration. Do not add
LangChain, LlamaIndex, an agent framework, a workflow engine, or a message bus.

**Background processing.** In-process `BackgroundTasks` is the current model.
Do not add Redis, Celery, Kafka, or RabbitMQ on the strength of the restart
limitation alone. Revisit when a real durability or multi-replica requirement
exists — then it is a decision record, not a drive-by dependency.

**Search.** Two axes and one fusion function is the whole retrieval structure:
`pgvector` for dense, `tsvector` + GIN for lexical, `fusion.fuse` for RRF. Do not
add OpenSearch, Elasticsearch, a vector database, a reranker model, or a second
scoring library. A new retrieval idea is a measurement first — see
`python -m scripts.evaluate` — and a dependency only if the measurement asks for
one.

**Database.** Reach for PostgreSQL before application code: `FK`, `UNIQUE`,
`CHECK`, `ON CONFLICT`, transactions, indexes, pgvector, `tsvector`, generated
columns. Schema changes go into
`scripts/migrations/` as a new numbered file, applied by
`python -m scripts.migrate`, and must stay confined to the `minutes` schema.
Application startup never issues DDL.

**Frontend.** React + TypeScript + Vite in `frontend/`, Tailwind tokens, Radix
primitives where accessibility is the hard part, TanStack Query for server
state. Do not add a global store (Redux/MobX/Zustand), a second UI kit, a form
library, an animation library, a runtime schema validator, or an OpenAPI client
generator — the app has two forms, twenty endpoints, and one source of truth,
which is the database. Do not add Next.js, a Node runtime server, an nginx
container, or a second repository: one image, one container, one origin.

**Deployment.** A single `compose.yaml` against an external PostgreSQL. Do not
add Kubernetes, Helm, a service mesh, or Terraform for an operational future
that has not arrived.

### `ponytail:` markers

When you deliberately take a simpler path with a known ceiling, record it at the
code site:

```python
# ponytail: <the simple choice and its actual ceiling>.
# Revisit when <a concrete, observable trigger>.
```

Real example, already in `app/services/transcript.py`:

```python
# ponytail: single best-overlap label per segment. A segment spanning a
# speaker change keeps one label; splitting it would need word timestamps.
```

Not acceptable — no ceiling, no trigger:

```python
# ponytail: improve later
```

Add a marker only where you actually made such a choice. Do not sweep existing
source to insert them.

## Before you write code

1. Turn the request into a verifiable goal. Write down what evidence will show it works.
2. Trace the real source flow for what you are touching — entry point through to
   the SQL. See [docs/workflows/development.md](docs/workflows/development.md).
3. If the target is a shared function, `grep` every caller before editing.
4. Check the relevant invariant in [AGENTS.md](AGENTS.md).
5. Search for an existing solution in the codebase.
6. Choose the smallest seam that achieves the goal.
7. Predict the side effects, including on data already in the database.
8. Decide how you will verify.
9. Then write code.

Reading the README is not step 2. The README summarizes; the source decides.

## While you write

- Match the surrounding style: type hints, short docstrings, module-level
  constants, Korean user-facing strings, English comments.
- No unrelated cleanup.
- A bug fix gets a regression test.
- Do not "fix" a failing existing test to make it pass. Find out why it fails.
- Change a test's expectation only when the behaviour genuinely changed, and say
  so.
- Do not change DB semantics quietly. Column meaning, nullability, and cascade
  behaviour are contracts.
- Changing retrieval semantics — distance operator, filter, Top-K, fusion
  constants, metadata rules, prompt — requires a stated reason, a decision
  record, and a BEFORE/AFTER from `python -m scripts.evaluate` on the same
  evaluation set. "It should help" is not a reason; a table is.
- Changing chunking parameters or the embedding model requires measurement, not
  intuition, and invalidates every stored vector. `scripts/evaluate.py
  --chunking` reports the criterion that actually matters: whether a fact's
  evidence still fits inside one chunk.
- A measured change that does not help does not ship. Record the rejection where
  someone would otherwise retry it — `lexical.STOPWORDS` carries one.
- Comments explain *why*, a measurement, or a ceiling. Never restate the code.

## Database changes

- Add a new numbered file under `scripts/migrations/`. Never edit one that has
  already been applied — its version is recorded, so the edit would never run.
- Apply it with `.venv/bin/python -m scripts.migrate`, before starting the app.
- Migrations only add. No `DROP`, no recreate: deployed databases hold real
  meetings.
- `minutes` schema only. Never touch another schema in this database.
- Changing the embedding model changes the vector dimension; `migrate.verify`
  refuses to start rather than corrupt the column. Plan for existing rows.
- Verify with a read-only query against the real database before and after.

## AI pipeline changes

Read [docs/workflows/ai-pipeline.md](docs/workflows/ai-pipeline.md) first — it
records each stage's responsibility, input, output, and failure behaviour.

- Keep each stage's responsibility intact (see AGENTS.md "AI model responsibilities").
- Changing stage order or adding a stage is a decision record.
- Every stage's failure behaviour is deliberate. Diarization failure degrades to
  a single speaker; an empty STT result fails the meeting. Do not change which
  failures are fatal without saying why.
- Provenance fields are a contract. Never drop one from a source payload. A
  structured fact carries the transcript text it came from; a claim without it
  must not be stored or returned.
- There is one transcript reader: `pipeline.load_transcript`. Extend it rather
  than writing a second `SELECT` over `transcript_segments`.
- A row's vector and its `lexemes` are written by the same statement, in the same
  function (`pipeline.index_transcript`, `intelligence.store`). Never add a
  second writer for one of them. `lexeme_tsv` is generated and is written by
  nobody.
- Four retrieval paths exist — dense chunk, lexical chunk, dense fact, lexical
  fact — and each pair shares one query builder so the scope predicate is one
  piece of text. A fifth path that writes its own `WHERE` is a defect, not a
  feature.
- A new retrieval path takes `meeting_ids` and applies it. The chat scope binds
  every layer identically — see AGENTS.md "Chat scope invariant".
- An LLM never produces an identifier, a date, or a speaker that the application
  then trusts. Validate against what the database already holds and drop what
  does not match; see `intelligence._validate`.

## Frontend changes

- `frontend/src` is the whole frontend. Work from the repository root; run npm
  commands inside `frontend/`.
- New API data needs a type in `api/types.ts` and a hook in `api/queries.ts`.
  Do not call `fetch` from a component.
- Colour, spacing, radius, and type come from `src/index.css`. Do not write a
  hex value in a component.
- Every dialog goes through `components/ui/Dialog.tsx`. Do not hand-roll a
  modal, and do not add a second way to close an existing one — Radix already
  owns ESC, the backdrop, focus trapping, and returning focus.
- A status label or tone belongs in `lib/labels.ts` / `components/ui/Badge.tsx`,
  once, so the same status cannot read differently on two screens.
- Narrowing a meeting list goes through `lib/meetings.ts:matches`. The meeting
  toolbar and the chat scope dialog share it; a second copy drifts the moment
  one gains a field.
- The chat reading column is `features/chat/canvas.ts:CANVAS`. Messages,
  evidence, and the composer all use it — do not hard-code a second max-width.
- Evidence under an answer starts closed and opens whole
  (`features/chat/SourceList.tsx`). Showing fewer sources is a presentation
  choice; returning or storing fewer is not, and is forbidden.
- Every row-action menu is `components/ui/Menu.tsx` (Radix DropdownMenu). Do not
  hand-roll a popover, and do not put two hover-revealed icon buttons on a row
  where one menu will do.
- "Why is this empty" belongs in `features/meetings/PendingNotice.tsx`, once. A
  panel with nothing in it must say which status it is waiting on and what the
  next human action is — never skeleton rows, which claim something is loading.
- Category CRUD lives on `/categories`. The meeting toolbar filters and links
  there; it does not manage.
- There is one sidebar (`components/AppShell.tsx`) and `ChatNav` is mounted once
  inside it. Do not add a second panel or a small-screen duplicate.
- Polling intervals are the `POLL_*` constants in `api/queries.ts`. Do not
  replace polling with a streaming transport for the current scale.
- Never use `dangerouslySetInnerHTML`.
- Persistent server state (chat scope, held_at, transcript) updates only after
  the server accepts it. Optimistic updates are for things a failure can undo
  invisibly, which none of those are.
- Before finishing: `npm run typecheck`, `npm run lint`, `npm test`. Run
  `npm run e2e` when you changed a flow the browser smoke covers.

## Tests and verification

Run these from the repository root. `pytest` is a development-only dependency and
is deliberately not in `requirements.txt` (it would ship in the image); install
it with `uv pip install pytest` if the venv lacks it.

Escalate in this order and stop at the last step your change actually affects:

```bash
# 1. targeted — the tests covering what you changed
.venv/bin/python -m pytest tests/test_core.py::test_assign_speakers_picks_max_overlap -q

# 2. full suite
.venv/bin/python -m pytest tests -q

# 2a. retrieval quality — after any change to chunking, embedding, retrieval,
#     fusion, or the lexical analyzer. Slow (real BGE-M3, real Kiwi) and it
#     builds and drops its own `minutes_eval` schema.
.venv/bin/python -m scripts.evaluate

# 2b. frontend — after any change under frontend/
cd frontend && npm run typecheck && npm run lint && npm test && cd ..

# 3. compose config validation — after any Dockerfile/compose.yaml/env change
docker compose config --quiet

# 4. image build — after any Dockerfile, requirements.txt, or frontend change
docker compose build

# 5. runtime smoke — after any change to startup, DB access, or the API
docker compose run --rm minutes python -m scripts.migrate   # after any migration change
docker compose up -d
curl -sf http://127.0.0.1:18080/health
curl -s http://127.0.0.1:18080/api/meetings
```

Step 5 talks to the real shared PostgreSQL. It is read-only unless you upload.

**Reporting rules.** Report PASS, FAIL, and SKIP separately with real counts. If
you ran only step 1, say that — never call it "all tests passed". If a step was
not applicable, say it was not run and why.

**Never** run `docker compose down -v`, `docker volume prune`, or any database
reset. Volumes hold the model cache and uploaded audio; the database is shared
with other applications.

## Documentation

Each fact has exactly one canonical home. Link, do not copy.

| file | holds |
|---|---|
| `README.md` | how to understand and run the project |
| `AGENTS.md` | repository invariants and boundaries |
| `CLAUDE.md` | this workflow |
| `docs/architecture/current.md` | current system structure in detail |
| `docs/workflows/` | repeatable procedures |
| `docs/decisions/` | why a significant choice was made |
| `docs/work-log/` | dated record of meaningful work |

After meaningful work, append to today's `docs/work-log/YYYY-MM-DD.md` — goal,
what was completed, how it was verified, blockers, decisions, next. Keep it
short. Do not paste shell transcripts, diffs, or git log; the work log is not a
substitute for git history. See [docs/work-log/index.md](docs/work-log/index.md).

Record a decision under `docs/decisions/` only for the categories listed in
[docs/decisions/README.md](docs/decisions/README.md). Bug fixes and UI polish do
not get one.

## Git

**Claude does not commit and does not push.**

Never run:

```
git commit      git push       git reset
git restore     git checkout -- <file>
git clean       git stash      git rebase
```

The working tree may hold the user's in-progress work. Never discard, revert, or
"tidy" it — including untracked files.

Allowed: `git status`, `git diff`, `git log`, `git show`.

When work is finished, report `git status` and propose a single commit message.
The user commits.

## Tool selection

All four are installed and available in this environment. A tool is a means, not
a goal — most tasks need none of them.

| tool | use for | do not use for |
|---|---|---|
| **Ponytail** (`full`, default) | every application change; minimal implementation, overengineering control, `ponytail:` debt markers | a substitute for correctness tests |
| **GSD** (`/gsd-*`) | genuinely multi-phase work — large architecture changes, features needing a roadmap | a one-file bug fix |
| **gstack** | its browser/QA and review skills, when a task actually calls for them | mandatory ceremony on every change |
| **devops-skills** | Dockerfile, compose, container, and deployment work | application business logic |

For a simple one- or two-file change: trace the source, edit, test. No workflow
ceremony.

## Deployment work

- Change source in this repository, never on a deployment host.
- A deployment host is not a development workspace. Do not edit tracked files there.
- Credentials, tokens, and server IPs never go into tracked files.
- Use devops-skills for Dockerfile and compose changes.
- Verify locally — build, then compose smoke — before deploying anything.

NCP deployment has not been performed and is not yet a repository invariant.
Do not write a runbook for a procedure that has not been executed. When a real
deployment happens, record the procedure then.
