# Categories become a tree, and the meeting list is narrowed and paged by PostgreSQL

**Date:** 2026-08-23
**Status:** accepted

## Context

Two things arrived together, and neither works without the other.

Meetings kept accumulating, and the list had no pagination: `GET /api/meetings`
returned every row and the browser filtered and sorted that array
(`lib/meetings.ts:matches`). That was recorded as a known ceiling in
[2026-08-21-meeting-categories-and-upload-held-at.md](2026-08-21-meeting-categories-and-upload-held-at.md)
and in AGENTS.md, with the note that a corpus large enough to need paging would
need a server query first.

Categories were a flat label list. The operational request was a real hierarchy —
업무 / 개발, 고객 / VOC — with the specific behaviour that **selecting a parent
returns the meetings filed under everything below it**. A browser cannot
implement that on a page it has already received, and it cannot implement it at
all once the list is paged: the meetings under a child category may not be on
this page.

So the choice was not "tree or no tree" but "where does narrowing happen".

## Decision

**Narrowing moved into SQL, and categories nest through one nullable
self-reference.**

- `meeting_categories.parent_id BIGINT REFERENCES meeting_categories(id) ON
  DELETE RESTRICT`, plus `CHECK (parent_id IS DISTINCT FROM id)` and an index
  (migration `008_category_hierarchy.sql`). Additive only: every existing
  category keeps `parent_id = NULL` and is a root, no row moves, no name changes.
- `name` stays globally `UNIQUE`, not unique per parent. A rendered path
  ("업무 / 개발") is therefore unambiguous everywhere it is shown, and no live
  constraint had to be dropped.
- A meeting still carries exactly one `category_id`. Moving a category moves no
  meeting; what changes is which filter reaches it.
- One recursive CTE, `categories.SUBTREE`, defines "this category and everything
  under it". The meeting list's category filter uses it, and so does the cycle
  check that refuses a move under a descendant (`A → B → A`). One definition,
  two callers.
- `categories.TREE` computes `path`, `depth`, the direct meeting count, and the
  child count in path order, so every screen renders the same hierarchy without
  rebuilding it in TypeScript.
- Deleting a category with children is refused (`409`), not cascaded — the
  foreign key refuses it even if the request bypasses the check. Its meetings
  keep the `ON DELETE SET NULL` behaviour they already had.
- `GET /api/meetings` now takes `page`, `page_size` (1–100, default 20), `q`,
  `category` (id, or `none`), `status`, `days`, `sort`, and returns
  `{items, total, page, page_size}`. `meetings._narrow` builds the predicate once
  and both the `COUNT` and the page query use it, so a total can never describe a
  different set from the rows. `sort` and `status` are whitelists.
- The frontend keeps one `MeetingQuery`: `toParams` for the paginated list,
  `matches` for the chat scope dialog, which is a picker over one already-fetched
  candidate set rather than a paged list. The list's whole query state lives in
  URL search parameters, because the toolbar and the new sidebar category tree
  both write it — and the app is explicitly not getting a store for two screens.

## Rejected

- **A `parent_id`-free tag/join table.** The request was nesting, not multiple
  classification. A join table would have changed what an assignment means and
  invalidated the "one category per meeting" invariant the UI, the filter, and
  the delete policy all rest on.
- **A closure table or nested set.** Both exist to make deep-tree reads cheap.
  This tree is a handful of nodes read once per screen; a recursive CTE over an
  indexed `parent_id` is already the cheap option, and neither alternative can be
  justified without a measurement nobody can take yet.
- **`sort_order`.** Name order inside a parent is enough today, and a column
  nothing sets is a column that lies later.
- **Unique-per-parent names.** It would mean dropping the live `UNIQUE (name)`
  from migration 006, which the migration rules here forbid, in exchange for
  ambiguous labels in every flat `<select>`.
- **Cascading a category delete to its children.** One click a level above the
  data would unfile every meeting in a subtree. Refusing costs the operator one
  extra step and cannot lose filing.
- **Keeping the browser filter and paging on top of it.** A page cannot be
  filtered into a correct total, and the descendant rule is unimplementable
  there. Keeping both would have meant two answers to "which meetings match".
- **A dual response shape** (array without parameters, envelope with them) to
  preserve the old contract. Two shapes for one endpoint is worse than one
  changed shape in a POC with one client, and every caller in this repository is
  in this repository.

## Consequences

- Easy: a new list filter is a `WHERE` clause and a query parameter; the
  descendant rule is one CTE; a deep link to a filtered page is a URL.
- Easy: the sidebar tree and the toolbar cannot disagree, because they write the
  same URL and read the same server answer.
- Harder: the meeting list is no longer usable offline from one fetch, and the
  search box now costs a request per keystroke (no debounce — see the limits in
  AGENTS.md).
- Harder: the chat scope dialog is capped at 100 approved meetings, which the
  dialog states. Lifting it means moving that picker to server-side search.
- Invalidated: `GET /api/meetings` clients expecting a bare array —
  `tests/test_categories.py` and the frontend were updated; nothing else
  consumed it. `lib/meetings.ts:matches` is now used only by the scope dialog.
- Not invalidated: no stored vector, no `lexemes`, no fact, and no chat message.
  Retrieval semantics are untouched — `category_id` is still not read by the
  pipeline or by retrieval, and the chat scope is still `meeting_ids`.
