-- Meetings become owned assets, shareable by invitation, and revisable without
-- taking the approved version out of search.
--
-- Three things arrive together because they are one model, not three features:
--
--   owner_user_id      who a meeting belongs to. The whole access rule reads it.
--   meeting_shares     who else may read it, and whether they accepted.
--   meeting_versions   which revision of the minutes is the published one.
--
-- Everything here is additive. No column is dropped, no table is recreated, and
-- no row's meaning changes for data that already exists.

-- ---------------------------------------------------------------- ownership

-- Nullable, deliberately. A meeting uploaded before this migration has no
-- recorded uploader, and inventing one would hand somebody else's recording to
-- an account that never made it. The backfill below only fills in what the data
-- itself proves; anything left NULL is an orphan, and the access predicate is
-- written so an orphan is readable by nobody rather than by everybody.
--
-- ON DELETE SET NULL, not CASCADE: removing an account must never delete the
-- recordings and approved minutes it owned. They become orphans that an operator
-- re-assigns, which is recoverable; a cascade is not.
ALTER TABLE {{SCHEMA}}.meetings
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT
        REFERENCES {{SCHEMA}}.users(id) ON DELETE SET NULL;

-- Every meeting list, every retrieval query, and every permission check filters
-- on this column.
CREATE INDEX IF NOT EXISTS idx_meetings_owner
    ON {{SCHEMA}}.meetings (owner_user_id);

-- Backfill step 1: the account that claimed a speaker in the meeting.
--
-- `meeting_user_speakers` is a deliberate act by a logged-in person on that one
-- meeting ("나로 지정"), which makes it the strongest evidence in this database
-- of who was working with it. Only when exactly one account did so — two
-- claimants prove nothing about who uploaded it.
UPDATE {{SCHEMA}}.meetings m
   SET owner_user_id = claimed.user_id
  FROM (
        SELECT meeting_id, min(user_id) AS user_id
          FROM {{SCHEMA}}.meeting_user_speakers
         GROUP BY meeting_id
        HAVING count(*) = 1
       ) AS claimed
 WHERE claimed.meeting_id = m.id
   AND m.owner_user_id IS NULL;

-- Backfill step 2: a single-account database.
--
-- Not a guess. If the whole `users` table holds one active account, that account
-- is the only one that could ever have uploaded anything, so attributing the
-- backlog to it states a fact rather than picking a candidate. With two or more
-- accounts this does nothing and the rows stay orphaned on purpose.
UPDATE {{SCHEMA}}.meetings m
   SET owner_user_id = (SELECT u.id FROM {{SCHEMA}}.users u WHERE u.is_active)
 WHERE m.owner_user_id IS NULL
   AND (SELECT count(*) FROM {{SCHEMA}}.users u WHERE u.is_active) = 1;

-- ------------------------------------------------------------------ sharing

-- One row per (meeting, invited account), for the life of that relationship.
--
-- Not one row per invitation event: a person is either invited to a meeting or
-- not, and a second row for the same pair would make "may this account read it"
-- a question about which row wins. Re-inviting after a refusal moves this row
-- back to PENDING, and the timestamps keep the history that matters.
--
-- REVOKED is a status rather than a delete, so "who was this shared with, and
-- when did the owner take it back" survives in the database.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_shares (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id         BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    -- The permission is a user id and never a name. A display name is a label
    -- that can change and can repeat; only the id identifies an account.
    invited_user_id    BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id) ON DELETE CASCADE,
    invited_by_user_id BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id) ON DELETE CASCADE,
    status             TEXT   NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When the invited person accepted or refused. NULL while PENDING.
    responded_at       TIMESTAMPTZ,
    -- When the owner took the share back. NULL unless REVOKED.
    revoked_at         TIMESTAMPTZ,
    -- Duplicate invitations are refused by the database, not by a SELECT first.
    UNIQUE (meeting_id, invited_user_id),
    -- Inviting yourself is meaningless: the owner already has every permission
    -- a share can grant. The sharer is always the owner, so this is the whole
    -- rule and the API does not have to restate it.
    CONSTRAINT meeting_shares_not_self CHECK (invited_user_id <> invited_by_user_id)
);

-- "What has been shared with me", the invitation inbox's only query.
CREATE INDEX IF NOT EXISTS idx_meeting_shares_invited
    ON {{SCHEMA}}.meeting_shares (invited_user_id, status);

-- ---------------------------------------------------------------- versioning

-- One row per revision of a meeting's minutes.
--
-- The problem this solves: an approved transcript is what every chunk, fact, and
-- citation rests on, so correcting one used to be impossible without rewriting
-- the evidence under a live index. A revision is now a *new* version — the
-- published one keeps its transcript and its index while the draft is edited,
-- and the swap happens only when the new version has finished indexing.
--
--   DRAFT       being edited. Not searchable, not visible to a shared reader.
--   INDEXING    approved and building its index. The previous version is still
--               the published one and still answers every question.
--   PUBLISHED   the version the application shows and searches. At most one.
--   SUPERSEDED  was published, and a later version replaced it. Its transcript
--               stays readable so an old answer's provenance still resolves.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_versions (
    meeting_id         BIGINT  NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    version            INTEGER NOT NULL CHECK (version > 0),
    status             TEXT    NOT NULL
                               CHECK (status IN ('DRAFT', 'INDEXING', 'PUBLISHED', 'SUPERSEDED')),
    -- Who started this revision. NULL for version 1 of a meeting that predates
    -- this migration, and for one whose author's account has been removed.
    created_by_user_id BIGINT  REFERENCES {{SCHEMA}}.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at       TIMESTAMPTZ,
    PRIMARY KEY (meeting_id, version)
);

-- At most one published version per meeting. This is the constraint the whole
-- switch rests on: "which version does search use" can never have two answers,
-- and a half-finished swap is refused by PostgreSQL rather than detected later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_versions_published
    ON {{SCHEMA}}.meeting_versions (meeting_id) WHERE status = 'PUBLISHED';

-- At most one open revision per meeting, whether it is being edited or indexed.
-- A second "회의록 수정" click therefore cannot fork the minutes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_versions_open
    ON {{SCHEMA}}.meeting_versions (meeting_id) WHERE status IN ('DRAFT', 'INDEXING');

-- Which revision each derived row belongs to.
--
-- transcript_segments keeps every version's words, which is what makes an old
-- citation still resolvable after a correction. chunks and meeting_facts only
-- ever hold the published version — they are rebuilt on every publish — and
-- carry the number so a returned source can say which minutes it came from.
ALTER TABLE {{SCHEMA}}.transcript_segments
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE {{SCHEMA}}.chunks
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE {{SCHEMA}}.meeting_facts
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- A sequence number identifies an utterance *within one version*. Unique rather
-- than a plain index: the reviewer's PATCH addresses a segment by
-- (meeting, version, sequence), and two rows answering to that address would let
-- an edit land on an arbitrary one of them. `_persist_transcript` has always
-- written these by DELETE-then-INSERT, so no existing row can violate it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_segments_meeting_version_sequence
    ON {{SCHEMA}}.transcript_segments (meeting_id, version, sequence);

-- Every meeting that already exists is version 1. A COMPLETED meeting is
-- serving an index right now, so its version is PUBLISHED; anything else has
-- never published one and is still a draft.
INSERT INTO {{SCHEMA}}.meeting_versions (meeting_id, version, status, created_at, published_at)
SELECT m.id,
       1,
       CASE WHEN m.status = 'COMPLETED' THEN 'PUBLISHED' ELSE 'DRAFT' END,
       m.created_at,
       CASE WHEN m.status = 'COMPLETED' THEN m.created_at END
  FROM {{SCHEMA}}.meetings m
 WHERE NOT EXISTS (
        SELECT 1 FROM {{SCHEMA}}.meeting_versions v WHERE v.meeting_id = m.id
       );
