-- When a meeting actually happened, and what an unproven fact status is called.
--
-- Both fix the same class of mistake: treating a value the system happened to
-- have as a value somebody actually stated.

-- created_at is when the recording was uploaded. It was standing in for the
-- meeting's own date in cross-meeting ordering and in relative-deadline
-- resolution, which is wrong for anything uploaded later than it was held —
-- a backlog import puts four meetings in one afternoon in registration order.
--
-- NULL means nobody has said when this meeting was held. Ordering falls back to
-- created_at so a legacy meeting still sorts deterministically, but the fallback
-- is labelled as a registration date wherever it is shown; it is never presented
-- as the time the meeting took place.
ALTER TABLE {{SCHEMA}}.meetings ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ;

-- OPEN was the default and the catch-all for any status the extraction did not
-- state, which made "아직 안 끝난 것" count facts nobody ever said were open.
-- UNKNOWN separates "the meeting said it is still open" from "the meeting did
-- not say". Widening a CHECK: every existing row still satisfies the new one.
ALTER TABLE {{SCHEMA}}.meeting_facts
    DROP CONSTRAINT IF EXISTS meeting_facts_status_check;
ALTER TABLE {{SCHEMA}}.meeting_facts
    ADD CONSTRAINT meeting_facts_status_check
        CHECK (status IN ('UNKNOWN', 'OPEN', 'DONE', 'CANCELLED', 'DEFERRED'));
ALTER TABLE {{SCHEMA}}.meeting_facts ALTER COLUMN status SET DEFAULT 'UNKNOWN';
