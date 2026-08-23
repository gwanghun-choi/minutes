-- Filing becomes personal. The meeting stays canonical.
--
-- Until now a category was one global vocabulary and `meetings.category_id` put
-- a meeting in one of its folders — a property of the meeting itself, editable
-- only by its owner. Sharing broke that: the owner's filing ("업무 / 구매부")
-- arrived on the reader's screen as if it were a fact about the recording, and
-- the reader had no way to file it under anything of their own.
--
-- So the filing moves off the meeting and onto the pair (account, meeting):
--
--   user_categories       one tree per account. Nobody else ever sees it.
--   user_meeting_filing   this account's category and display name for one
--                         meeting. Owner and shared reader both get a row, and
--                         neither row is visible to the other.
--
-- Nothing canonical is touched. `meetings.title` is the recording's name and
-- only the owner's upload sets it; an alias here changes what one account sees
-- and nothing else. `meetings.category_id` and `meeting_categories` are left in
-- place — additive migrations only — and the application stops reading them
-- once the backfill below has moved what they held.

-- --------------------------------------------------------------- categories

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.user_categories (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id) ON DELETE CASCADE,
    name       TEXT   NOT NULL,
    parent_id  BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Unique per account, not globally: two people may both have a 업무 folder,
    -- and neither can have two. The same duplicate policy migration 006 chose,
    -- narrowed to the scope the tree now lives in.
    UNIQUE (user_id, name),
    -- Redundant against the primary key, and it is what lets the two composite
    -- foreign keys below carry `user_id` along with the category id. That is the
    -- whole cross-account guard: a filing or a parent cannot name a category
    -- belonging to somebody else, because the reference includes whose it is.
    UNIQUE (user_id, id),
    CONSTRAINT user_categories_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
    -- ON DELETE RESTRICT, like migration 008: deleting a parent must not
    -- silently take its children. A longer cycle (A -> B -> A) is refused by the
    -- recursive walk in `app/services/organization.py`.
    CONSTRAINT user_categories_parent_fk
        FOREIGN KEY (user_id, parent_id)
        REFERENCES {{SCHEMA}}.user_categories (user_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_user_categories_parent
    ON {{SCHEMA}}.user_categories (user_id, parent_id);

-- ------------------------------------------------------------------ filing

-- One row per (account, meeting): how that account, and only that account, has
-- chosen to see that meeting.
--
-- The primary key is the pair, so an account has exactly one filing per meeting
-- and two accounts cannot collide. Everything in the row is optional — a row
-- with a NULL category and a NULL alias means the same as no row at all, which
-- is what keeps "미분류, canonical title" the default with nothing stored.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.user_meeting_filing (
    user_id     BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id) ON DELETE CASCADE,
    meeting_id  BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    category_id BIGINT,
    -- What this account calls the meeting. NULL means the canonical title, which
    -- is why it is nullable rather than defaulted: a copy of the title would go
    -- stale the moment the owner renamed the recording.
    alias       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, meeting_id),
    -- Carries user_id into the reference, so this row can only ever point at one
    -- of its own account's categories. RESTRICT rather than SET NULL: deleting a
    -- category clears the filings first, in the same transaction, so the alias
    -- beside the category survives a folder being removed.
    CONSTRAINT user_meeting_filing_category_fk
        FOREIGN KEY (user_id, category_id)
        REFERENCES {{SCHEMA}}.user_categories (user_id, id) ON DELETE RESTRICT
);

-- "Everything I filed under this category", the sidebar's only query.
CREATE INDEX IF NOT EXISTS idx_user_meeting_filing_category
    ON {{SCHEMA}}.user_meeting_filing (user_id, category_id);

-- ------------------------------------------------------------------- chats

-- A conversation is already owned by one account, so its filing is a column
-- rather than a second table — the same tree, the same guard.
ALTER TABLE {{SCHEMA}}.chat_sessions
    ADD COLUMN IF NOT EXISTS category_id BIGINT;

DO $$
BEGIN
    ALTER TABLE {{SCHEMA}}.chat_sessions
        ADD CONSTRAINT chat_sessions_category_fk
        FOREIGN KEY (user_id, category_id)
        REFERENCES {{SCHEMA}}.user_categories (user_id, id) ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;   -- already added; nothing to change
END $$;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_category
    ON {{SCHEMA}}.chat_sessions (user_id, category_id);

-- ---------------------------------------------------------------- backfill

-- What the old global filing proves, and nothing more.
--
-- `meetings.category_id` says how the *owner* filed their own meeting, so it
-- becomes that owner's personal filing. It says nothing about how anybody else
-- would file it, so no other account gets a row — a shared reader starts with an
-- empty tree, which is the point of the change. A meeting with no owner
-- (migration 009 could not prove one) is skipped: there is nobody to give it to.

-- Step 1: recreate, per owner, the categories they were actually using, plus
-- every ancestor of those, so the hierarchy survives rather than flattening.
WITH RECURSIVE used AS (
    SELECT DISTINCT m.owner_user_id AS user_id, k.id, k.name, k.parent_id
      FROM {{SCHEMA}}.meetings m
      JOIN {{SCHEMA}}.meeting_categories k ON k.id = m.category_id
     WHERE m.owner_user_id IS NOT NULL
    UNION
    SELECT u.user_id, p.id, p.name, p.parent_id
      FROM used u
      JOIN {{SCHEMA}}.meeting_categories p ON p.id = u.parent_id
)
INSERT INTO {{SCHEMA}}.user_categories (user_id, name)
SELECT user_id, name FROM used
ON CONFLICT (user_id, name) DO NOTHING;

-- Step 2: hang them off each other the way the global tree had them. Names are
-- the join key because migration 006 made them globally unique, so the mapping
-- from a global category to its personal copy is exact.
WITH RECURSIVE used AS (
    SELECT DISTINCT m.owner_user_id AS user_id, k.id, k.name, k.parent_id
      FROM {{SCHEMA}}.meetings m
      JOIN {{SCHEMA}}.meeting_categories k ON k.id = m.category_id
     WHERE m.owner_user_id IS NOT NULL
    UNION
    SELECT u.user_id, p.id, p.name, p.parent_id
      FROM used u
      JOIN {{SCHEMA}}.meeting_categories p ON p.id = u.parent_id
)
UPDATE {{SCHEMA}}.user_categories child
   SET parent_id = parent.id
  FROM used u
  JOIN {{SCHEMA}}.meeting_categories gp ON gp.id = u.parent_id
  JOIN {{SCHEMA}}.user_categories parent
    ON parent.user_id = u.user_id AND parent.name = gp.name
 WHERE child.user_id = u.user_id
   AND child.name = u.name
   AND child.parent_id IS NULL;

-- Step 3: the filings themselves.
INSERT INTO {{SCHEMA}}.user_meeting_filing (user_id, meeting_id, category_id)
SELECT m.owner_user_id, m.id, uc.id
  FROM {{SCHEMA}}.meetings m
  JOIN {{SCHEMA}}.meeting_categories k ON k.id = m.category_id
  JOIN {{SCHEMA}}.user_categories uc
    ON uc.user_id = m.owner_user_id AND uc.name = k.name
 WHERE m.owner_user_id IS NOT NULL
ON CONFLICT (user_id, meeting_id) DO NOTHING;
