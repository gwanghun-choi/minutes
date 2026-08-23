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
   `rag.serialize_sources`, `rag._fmt_time`, `rag.is_self_scoped`, `db.conn`,
   `config.resolve_device`, `lexical.lexemes`, `lexical.tsquery`, `fusion.fuse`,
   `fusion.meta_hits`, `intelligence.store`, `organization.SUBTREE`,
   `organization.FILING`, `organization.COLUMNS`, `organization.owned`,
   `organization.file_meeting`, `organization.aliases`,
   `rag.cited_sources`, `meetings._narrow`, `meetings._editable_draft`, `access.READABLE`,
   `access.require_read`, `access.require_owner`, `access.visible`,
   `versions.published`, `versions.open_version`, and `versions.publish` already
   exist on the backend; `api/client.ts`, `api/queries.ts`, `lib/format.ts`,
   `lib/labels.ts`, `lib/meetings.ts`, `features/chat/canvas.ts`,
   `features/chat/SourceDrawer.tsx`, `features/meetings/PendingNotice.tsx`,
   `features/meetings/CategoryNav.tsx`, `features/meetings/SharePanel.tsx`,
   `features/meetings/InvitationBell.tsx`, `features/meetings/FilingActions.tsx`,
   `components/AppShell.tsx`'s `PageHeader` / `PageBody`, and `components/ui/*`
   (including `Menu.tsx`, `Dialog.tsx`, `Popover.tsx`, `Tabs.tsx`, and
   `Badge.tsx`'s `SharedBadge`) already exist on the frontend — reuse them.
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
layer, a DI framework, or a generic service abstraction. A handful of tables and
a handful of queries do not need a persistence layer.

**Minutes are immutable once approved.** `meetings._editable_draft` is the one
gate in front of every transcript write, and it opens only for a `DRAFT` on a
`REVIEW_REQUIRED` meeting. Do not add a revision workflow, a rollback, an
"edit approved minutes" endpoint, or a second gate — and do not hide a control
instead of refusing the request.

**Authorization.** `app/services/access.py` is the whole thing: one SQL predicate
and two roles. Do not add a role table, a permission matrix, an RBAC library, a
policy engine, or a decorator framework. A new endpoint calls
`access.require_read` or `access.require_owner`, and a new query pastes
`access.READABLE`. Sharing is an invitation to one account by id — never a link,
a token, or anonymous access.

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

**Deployment.** A single `compose.yaml` against an external PostgreSQL, reached
by container name over the external Docker network `minutes-net`
(`networks.default`, so one-off `docker compose run` containers get it too). Do
not add a PostgreSQL service, a per-service network block, a
`compose.override.yaml`, or Kubernetes, Helm, a service mesh, or Terraform for an
operational future that has not arrived.

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
- Any query that reads a meeting takes the caller into account. Reach for
  `access.READABLE` rather than writing the predicate again — a second version of
  "who may read this" is how a leak gets written.
- Anything derived from a transcript names its version. `pipeline.load_transcript`
  takes one, and `chunks` / `meeting_facts` store one.
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
- What a control is allowed to do comes from `role` / `draft_version` on the
  detail response, not from `meeting.status` and not from a client-side guess.
  Hiding a control is presentation; the server refuses it either way.
- A status label or tone belongs in `lib/labels.ts` / `components/ui/Badge.tsx`,
  once, so the same status cannot read differently on two screens.
- Narrowing the meeting list happens in SQL, in `app/api/meetings.py:_narrow`,
  and the COUNT and the page share that one predicate. On the frontend
  `lib/meetings.ts` holds the one `MeetingQuery`: `toParams` for the paginated
  list, `matches` for the chat scope dialog's already-fetched candidate set. Do
  not add a third way to narrow a meeting list.
- The meeting list's query state lives in the URL (`q`, `category`, `status`,
  `days`, `sort`, `page`, `size`), because the toolbar and the sidebar category
  tree both write it. Changing a filter resets to page 1; do not add a store.
- "This category and everything under it" is
  `app/services/organization.py:SUBTREE`, used by the list filter and by the
  cycle check. A second descendant walk is a defect. `path` and `depth` come from
  the database; do not rebuild the tree in the browser.
- **Filing is personal; canonical data is not.** A category and an alias are rows
  in `user_meeting_filing`, writable by any reader of the meeting, and they must
  never touch `meetings`. Read them through `organization.COLUMNS` /
  `organization.FILING` so `display_title` means one thing everywhere. A filing
  row grants nothing — `access.READABLE` is still the only door.
- The chat reading column is `features/chat/canvas.ts:CANVAS`. Messages,
  evidence, and the composer all use it — do not hard-code a second max-width.
- Evidence opens in the 출처 drawer over the conversation, closed by default and
  whole when open (`features/chat/SourceDrawer.tsx`). It is always mounted and
  slides on `translate-x`; do not go back to conditional rendering, which made
  the chat column jump its full width in one frame. The `출처 N개` control is a
  toggle and a `[N]` citation focuses one card. **The drawer renders
  `message.cited_sources` and nothing else, and the count on the control is its
  length** — the two cannot disagree, because they read one list the server
  computed (`rag.cited_sources`). The full retrieved set stays in
  `message.sources` and in `chat_messages.sources`; returning or storing fewer is
  forbidden, and so is putting the unquoted half back on the screen. `출처` is
  user-facing copy only — do not rename `serialize_sources`, the `[근거]` prompt
  block, or `chat_messages.sources`.
- **Summary and insight generation are one policy.** Both produce a single
  artifact every reader retrieves from, so both are owner-only — `require_owner`
  on the server, `canGenerate` on `SummaryPanel` and `IntelligencePanel`. Do not
  let one of them draw a button the other hides.
- **[공유] is derived from permission, never from a name.** `is_owner` on a list
  row and `role` on the detail response are what `components/ui/Badge.tsx:SharedBadge`
  reads. Never write the marker into a title or an alias — an alias is the one
  thing the recipient can change, and the badge has to survive it.
- Renaming a meeting for myself and filing it in my own category are reachable
  from the row menu on any list (`features/meetings/FilingActions.tsx`), for a
  shared reader as much as an owner. Only 삭제 is the owner's. Those two are the
  *only* surfaces for it — the meeting detail page had an 내 정리 panel of its
  own and it is gone, because filing is something you do to a row while looking
  at rows. Do not put a third one back, read-only or otherwise.
- The sidebar tree asks the list endpoint for `descendants=0`. The list page
  means a folder *and the work under it*; the tree draws the folders itself, so
  a meeting belongs under the one it is filed in and nowhere else. Two rows for
  one meeting is two links to one page, and on that page two rows marked
  current.
- Every row-action menu is `components/ui/Menu.tsx` (Radix DropdownMenu). Do not
  hand-roll a popover, and do not put two hover-revealed icon buttons on a row
  where one menu will do.
- "Why is this empty" belongs in `features/meetings/PendingNotice.tsx`, once. A
  panel with nothing in it must say which status it is waiting on and what the
  next human action is — never skeleton rows, which claim something is loading.
- Category CRUD lives in the sidebar tree
  (`features/meetings/CategoryNav.tsx`) and nowhere else — there is no
  `/categories` page and adding one back is a regression. An invitation is a
  notification (`features/meetings/InvitationBell.tsx`), not a route.
- A control's width belongs to the caller. `components/ui/controls.tsx` no
  longer sets one: Tailwind emits `.w-full` after every other width, so a base
  `w-full` silently beat `w-56` and `w-auto` and turned the filter bar into
  four full-width rows. Say `w-full`, a fixed width, or `flex-1` at the site.
- There is one sidebar (`components/AppShell.tsx`) and it holds one panel:
  `ChatNav` on the chat route, `CategoryNav` everywhere else, each mounted once.
  Do not add a second panel or a small-screen duplicate.
- Every screen renders exactly one `PageHeader`, and it owns the top-right
  utilities — the 공유 알림 bell and the account menu — so they sit in one place
  on every route and are mounted once. A notification is not a navigation item
  and not a route; do not put one back in the sidebar. Under the header goes one
  `PageBody`, which is the only thing that scrolls from `md`.
- One tab strip, `components/ui/Tabs.tsx`, for both the list's scope tabs and the
  detail page's. It is hand-rolled deliberately: Radix Tabs couples a trigger to
  a `Tabs.Content` and both of these strips drive a single URL-driven region, so
  its `aria-controls` would name panels that do not exist.
- A controlled `<select>` whose options arrive in a second request has to be
  keyed on the option set. Without that the browser resets the node to "" while
  the list is empty and React, seeing the same `value` it already rendered,
  never writes it back — see `FilingActions.tsx`'s `MoveDialog`.
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
