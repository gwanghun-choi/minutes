# Meeting categories as one nullable FK, and a proposed held_at on upload

**Date:** 2026-08-21
**Status:** accepted

## Context

Two problems in the same area, both about meeting metadata.

**Organizing meetings.** The meeting list was a flat table with one status
filter. Six meetings are fine that way; a quarter of recordings is not. The
question was how much structure to add — tags, folders, a tree — before knowing
how the tool is actually used.

**The meeting date nobody enters.** `meetings.held_at` (migration 005) is what
cross-meeting chronology and relative deadline resolution read, and it is NULL
until an operator opens the meeting detail page and fills it in. Every one of
the six meetings in the shared database still has `held_at = NULL`, which means
every one of them is being ordered by its upload time under a `등록` label. The
field exists and nothing populates it.

The tempting fix — `held_at TIMESTAMPTZ NOT NULL DEFAULT now()` — is the exact
mistake migration 005 was written to undo. It would make every future upload
claim a meeting date that is really an upload time, and the column would stop
meaning anything.

## Decision

**Categories: one nullable FK, and that is the whole model.**

```sql
CREATE TABLE meeting_categories (id, name TEXT NOT NULL UNIQUE, created_at, updated_at);
ALTER TABLE meetings ADD COLUMN category_id BIGINT
    REFERENCES meeting_categories(id) ON DELETE SET NULL;
```

- A meeting has 0 or 1 category. `NULL` is 미분류 — not a row, not a sentinel.
- `UNIQUE(name)` is the duplicate policy. A create that collides is a `409`; the
  application never checks first, because a check plus an insert is a race the
  constraint already wins.
- `ON DELETE SET NULL`, never `CASCADE`. A label is not a container: deleting
  `고객 미팅` must move its meetings to 미분류 and delete nothing. PostgreSQL
  does that with no application code, and the UI says so before the click.
- Assignment is `PUT /api/meetings/{id}/category`, shaped like the two endpoints
  beside it (`/held-at`, `/me`). Editable at any status: a category is metadata
  about a meeting, not a word of its approved transcript.

**held_at: proposed by the browser, never inferred by the server.**

- `POST /api/meetings` takes an optional `held_at` form field. Omitted or empty
  means NULL; anything that is not ISO 8601 is a `400`, not a guess.
- The upload dialog pre-fills it with **now, in the browser's timezone**, and the
  user can change or clear it before sending. Today is the right guess for a
  recording being uploaded today, and it is a guess the person uploading can see
  and correct.
- No DB default, and **no backfill of existing rows**. The six meetings with
  `held_at = NULL` keep it: nobody knows when they were held, and writing their
  upload time into the column would erase that fact rather than record it.

**Filtering stays in the browser.** `GET /api/meetings` already returns every
row and is polled every three seconds; text, category, status, and date-range
filters run over that array in `frontend/src/lib/meetings.ts`, shared by the
meeting list and the chat scope dialog. No new query parameters.

## Rejected

- **Tags (`meeting_tags` join table).** Many-to-many for a need nobody has
  stated. One category answers "which meetings are these" today; a join table
  would be built now and understood later.
- **A category tree.** Nesting needs a parent column, cycle prevention, and a
  UI that renders depth. Not for five labels.
- **A per-user category list.** Meetings deliberately have no ownership in this
  system (see AGENTS.md "Product boundary"); giving their labels one would be
  the first ownership rule in the product, introduced by a filter dropdown.
- **`held_at NOT NULL DEFAULT now()`.** Rejected for the reason 005 exists: it
  reintroduces "the upload time is the meeting time" as a schema fact.
- **Backfilling `held_at = created_at` on existing rows.** Same reasoning as the
  005 decision record. The fallback is labelled `등록` precisely so nobody has
  to guess.
- **A category-management page.** A dialog opened from the filter that uses
  categories is enough; a route for four CRUD operations is a screen that
  exists to hold a form.
- **Server-side filter/sort query parameters.** A round trip per keystroke, for
  a list that already arrives whole. Recorded as a ceiling in `lib/meetings.ts`:
  revisit when `/api/meetings` needs pagination.
- **A generic `PATCH /api/meetings/{id}`.** One field, one endpoint, matching
  the two that already exist. A partial-update endpoint would have to decide
  what is editable at which status for every column at once.

## Consequences

- Migration `006_meeting_categories.sql` adds one table, one nullable column,
  and one index. It only adds; an existing database crosses it untouched.
- Existing rows are unchanged: `category_id` NULL and `held_at` NULL, verified
  against the shared database after applying it.
- A category name is global. Renaming one changes what every meeting displays,
  which is why the rename invalidates both the category list and the meeting
  list.
- `scope_meeting_ids` still has no foreign key, so the chat scope's existing
  limitation is unchanged — a deleted meeting's id simply retrieves nothing.
- Nothing in the AI pipeline reads `category_id`. Retrieval scope is still
  `meeting_ids`, and a category is a way for a person to pick those ids, never
  a filter the backend applies on its own.
