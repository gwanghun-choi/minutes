# Decision records

Why a significant choice was made, and what it ruled out.

Three records exist:
[2026-08-20-hitl-transcript-review-gate.md](2026-08-20-hitl-transcript-review-gate.md),
[2026-08-20-poc-identity-and-persistent-chat.md](2026-08-20-poc-identity-and-persistent-chat.md),
and
[2026-08-21-explicit-db-migration-and-db-managed-identity.md](2026-08-21-explicit-db-migration-and-db-managed-identity.md).
The choices made while building the MVP are recorded in
[../work-log/2026-08-20.md](../work-log/2026-08-20.md); they were not back-filled
into records here, because reconstructing intent after the fact produces
documents that look authoritative and are not.

## When to write one

Only for changes that alter how the system fundamentally behaves:

- database semantics — column meaning, nullability, cascade behaviour, schema shape
- pipeline ordering, or adding/removing a stage
- chunking strategy or its constants
- embedding model, or anything that changes vector dimension
- retrieval semantics — distance operator, filter, Top-K, evidence prompt
- introducing a significant dependency
- persistence semantics — where data lives, what survives a restart
- the background execution model
- deployment architecture

Not for bug fixes, UI polish, copy changes, refactors, or test additions. If you
are unsure, it probably does not need one.

## Format

`YYYY-MM-DD-short-title.md`, and keep it short:

```markdown
# <decision>

**Date:** YYYY-MM-DD
**Status:** accepted | superseded by <file>

## Context
What forced a choice. Include the measurement or constraint, if there was one.

## Decision
What was chosen.

## Rejected
What else was considered, and why not.

## Consequences
What this makes easy, what it makes hard, and what data or code it invalidates.
```

Link the record from the work-log entry for that day.
