-- The same recording, uploaded twice by the same account, is one meeting.
--
-- Analysis is the expensive part of this product: FFmpeg, faster-whisper,
-- pyannote, BGE-M3, Kiwi, and an OpenAI extraction all run once per upload. A
-- second upload of a file already analysed spends all of it again and leaves the
-- account with two identical meetings to tell apart. The cheapest place to
-- notice is before any of that starts, and the only thing that identifies a
-- recording is its bytes -- a filename is a label the uploader chose.
--
-- Identity is (owner, content), never content alone. Two accounts holding the
-- same file are two meetings: they are separate recordings as far as either
-- account can tell, and collapsing them would say to one account that another
-- one has this audio. Ownership is also what makes the guard nothing more than
-- a convenience -- a share grants reading, never a claim on the bytes, so an
-- accepted reader may still upload the same file as their own meeting.

-- SHA-256 of the *original* uploaded file, lowercase hex. NULL on every meeting
-- that predates this migration and on any row whose bytes were never hashed:
-- the column is additive and nothing here walks the upload directory to fill it
-- in. A NULL simply takes part in no comparison, which is the direction this has
-- to fail in -- an unknown hash must never look equal to another unknown hash.
ALTER TABLE {{SCHEMA}}.meetings
    ADD COLUMN IF NOT EXISTS source_content_hash TEXT;

DO $$
BEGIN
    ALTER TABLE {{SCHEMA}}.meetings
        ADD CONSTRAINT meetings_source_content_hash_format
        CHECK (source_content_hash ~ '^[0-9a-f]{64}$');
EXCEPTION
    WHEN duplicate_object THEN NULL;   -- already added; nothing to change
END $$;

-- The last line of defence, and the reason the application may check with a
-- plain SELECT. Two concurrent uploads of one file both find nothing and both
-- insert; exactly one of them survives, and the loser is turned into the same
-- 409 the SELECT would have produced.
--
-- Partial, so the legacy rows do not collide with each other: a unique index
-- treats NULLs as distinct anyway, and stating it keeps the index off every row
-- that can never take part in the comparison. An orphan meeting (NULL owner,
-- migration 009) is likewise never anybody's duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_owner_source_hash
    ON {{SCHEMA}}.meetings (owner_user_id, source_content_hash)
    WHERE source_content_hash IS NOT NULL;
