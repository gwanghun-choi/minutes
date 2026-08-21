# Development workflow

The repeatable loop for changing anything in this repository.
Principles are in [AGENTS.md](../../AGENTS.md); posture and tool choice in
[CLAUDE.md](../../CLAUDE.md).

## 1. Understand

Restate the request as a verifiable goal. Write down, before touching anything:

- what will be true when this is done
- what evidence will show it

If the request has two readings that produce different work, surface that now.

## 2. Trace

Follow the real path, not the README.

```bash
# where does the route live
grep -rn "router\|@app.get\|@app.post" app/main.py app/api/

# who calls the function you are about to change
grep -rn "assign_speakers\|build_chunks\|serialize_sources" app/ tests/

# what SQL actually runs
grep -rn "execute(" app/
```

Entry points:

| starting from | read |
|---|---|
| an HTTP endpoint | `app/main.py` → `app/api/*.py` |
| the analysis pipeline | `app/services/pipeline.py:process` |
| retrieval or answers | `app/services/rag.py` |
| anything touching the database | `app/db.py`, `scripts/migrations/` |
| the UI | `app/templates/*.html` → `app/static/app.js` |

Full map: [../architecture/current.md](../architecture/current.md).
Per-stage detail: [ai-pipeline.md](ai-pipeline.md).

## 3. Check invariants

Read the relevant section of [AGENTS.md](../../AGENTS.md). If the change would
break an invariant, that is the conversation to have — not something to work
around.

## 4. Choose the smallest seam

Climb the Ponytail ladder in [CLAUDE.md](../../CLAUDE.md). One guard in a shared
function beats a guard in every caller; a database constraint beats both.

## 5. Modify

Surgical changes only. Existing style. Nothing unrelated.

## 6. Verify

Run the escalation ladder in [CLAUDE.md](../../CLAUDE.md#tests-and-verification)
— targeted test, full suite, compose config, image build, runtime smoke — and
stop at the last step your change actually affects. That section is the canonical
list of commands and the rules for reporting PASS / FAIL / SKIP.

Two things specific to this step:

- If you changed logic with a branch, a loop, or a parser and no test covers it,
  add one before moving on.
- Cold container start is slow — the first run downloads faster-whisper and
  BGE-M3 into the `models` volume. Later starts reuse it.

## 7. Documentation

Update the one canonical location the change affects:

- structure changed → `docs/architecture/current.md`
- a pipeline stage changed → `docs/workflows/ai-pipeline.md`
- an invariant or limitation changed → `AGENTS.md`
- a significant choice was made → a new file in `docs/decisions/`
- always → append to today's `docs/work-log/YYYY-MM-DD.md`

Do not repeat the same fact in a second file. Link instead.

## 8. Report

```bash
git status
git diff
git diff --check
```

Report what changed, what was verified and how, and what was not. Then propose a
commit message — the git safety rules are in
[CLAUDE.md](../../CLAUDE.md#git), and they are not optional.

## Environment setup

See [README.md](../../README.md#8-실행). Configuration comes from `.env`
(git-ignored) via `app/config.py`; `.env.example` lists every variable. Never
print a secret's value while inspecting configuration.
