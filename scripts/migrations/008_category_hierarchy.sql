-- Categories become a tree: one nullable self-reference, nothing else.
--
-- A meeting still has 0 or 1 category (`meetings.category_id` is unchanged), so
-- this adds no join table and no second assignment path. Selecting a parent in
-- the UI widens the *query* through a recursive CTE, not the assignment.
--
-- Every category that exists when this runs keeps parent_id NULL and is
-- therefore a root. No row moves, and no name changes.
ALTER TABLE {{SCHEMA}}.meeting_categories
    -- ON DELETE RESTRICT, deliberately not CASCADE: deleting a parent must not
    -- silently take its children (and their meetings' filing) with it. The API
    -- turns the refusal into a sentence that names the children.
    ADD COLUMN IF NOT EXISTS parent_id BIGINT
        REFERENCES {{SCHEMA}}.meeting_categories(id) ON DELETE RESTRICT;

-- The descendant lookup walks parent_id downwards on every filtered meeting
-- query, so it gets its own index rather than a sequential scan per level.
CREATE INDEX IF NOT EXISTS idx_meeting_categories_parent
    ON {{SCHEMA}}.meeting_categories (parent_id);

-- A category cannot be its own parent. A longer cycle (A -> B -> A) cannot be
-- expressed as a row constraint, so it is refused by the recursive descendant
-- check in `app/api/categories.py:_would_cycle` before the UPDATE runs.
DO $$
BEGIN
    ALTER TABLE {{SCHEMA}}.meeting_categories
        ADD CONSTRAINT meeting_categories_not_own_parent
        CHECK (parent_id IS DISTINCT FROM id);
EXCEPTION
    WHEN duplicate_object THEN NULL;   -- already added; nothing to change
END $$;

-- `name` stays globally UNIQUE (migration 006), not unique per parent. Two
-- categories a person cannot tell apart are still worse than a 409, and a
-- globally unique name keeps the rendered path ("업무 / 개발") unambiguous
-- everywhere it is shown. Relaxing it would mean dropping a live constraint,
-- which migrations here do not do.
