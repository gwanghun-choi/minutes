# Work log

One file per day: `YYYY-MM-DD.md`. Newest first.

| date | summary |
|---|---|
| [2026-08-21](2026-08-21.md) | Database DDL removed from application startup and replaced by an explicit migration runner (`scripts/migrate.py` + `scripts/migrations/`) with `schema_migrations` version tracking; `minutes.users` became the source of truth for accounts (`display_name`, `is_active`, `updated_at`, `last_login_at`, migration-seeded POC account), replacing the `MINUTES_BOOTSTRAP_*` startup bootstrap. |
| [2026-08-20](2026-08-20.md) | MVP implemented and committed (`0331794`); repository governance and `docs/` established; HITL transcript review gate added; first NCP deployment; `pyannote.audio` 4.0.0 → 4.0.7 for the torch 2.13 checkpoint-load failure; real-audio E2E UAT on NCP (diarization → HITL gate → indexing → RAG); re-embedding added for approved meetings; meeting deletion added; Productization Wave 1 — POC login, persistent multi-turn chat, meeting scope picker with explicit-only global fallback, meeting summary, AI transcript correction, speaker colours. |

## How to use it

After meaningful work, append to today's file under the matching heading. Create
the file from the structure used by the entries above if it does not exist yet,
and add a row here.

Record:

- **Goal** — what the work was for
- **Completed** — what actually changed
- **Verified** — the command run and its real result, including SKIP and FAIL
- **Blockers** — what is stopping progress, and what would unblock it
- **Decisions** — a link to `../decisions/`, if one was recorded
- **Next** — what follows

Do not record: shell transcripts, per-file diffs, typo fixes, a copy of
`git log`, or every command executed. The work log is not a substitute for git
history — it captures why and what was verified, which git does not.

Only facts confirmed from the repository, its tests, or an observed run. If
something was not verified, write that it was not.
