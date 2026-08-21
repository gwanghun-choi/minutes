-- One optional category per meeting.
--
-- A flat list, deliberately: not a tag join table and not a tree. A meeting has
-- 0 or 1 category, so a nullable FK on `meetings` is the whole model — NULL is
-- 미분류, and there is nothing to normalize away.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_categories (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- UNIQUE is the duplicate policy: two categories a person cannot tell apart
    -- are worse than a 409 on create. The application never checks first.
    name       TEXT        NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ON DELETE SET NULL, never CASCADE: removing a label must not remove the
-- meetings wearing it. Deleting a category moves its meetings to 미분류, and
-- PostgreSQL does that without any application code.
ALTER TABLE {{SCHEMA}}.meetings
    ADD COLUMN IF NOT EXISTS category_id BIGINT
        REFERENCES {{SCHEMA}}.meeting_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_meetings_category
    ON {{SCHEMA}}.meetings (category_id);
