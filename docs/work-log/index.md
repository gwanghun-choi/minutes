# Work log

One file per day: `YYYY-MM-DD.md`. Newest first.

| date | summary |
|---|---|
| [2026-08-20](2026-08-20.md) | MVP implemented and committed (`0331794`); repository governance and `docs/` established; HITL transcript review gate added. |

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
