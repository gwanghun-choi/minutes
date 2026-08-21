-- Meeting Intelligence: the structured layer over an approved transcript.
--
-- chunks answer "what was said". These tables answer "who asked whom to do what,
-- by when, and what was decided" — in PostgreSQL, with pgvector, not a graph DB.
-- Every fact points back at the transcript segments it came from, so a structured
-- answer can always be taken back to the original words.

-- Lets a composite foreign key state, in the database, that a mapped speaker
-- belongs to the meeting it is mapped in. speakers.id is already the primary key;
-- this index only adds the meeting_id pairing a FK can reference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_speakers_id_meeting
    ON {{SCHEMA}}.speakers (id, meeting_id);

-- Which diarized speaker is the logged-in person, per meeting. pyannote's
-- SPEAKER_00 is a per-meeting label, never an account, so "내가 요청한 것" needs
-- this bridge to mean anything.
--
-- PRIMARY KEY (meeting_id, user_id): one user is one speaker in a meeting.
-- UNIQUE (meeting_id, speaker_id): one speaker is one user in a meeting.
-- The composite FK: the speaker must be a speaker of that same meeting.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_user_speakers (
    meeting_id BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id)    ON DELETE CASCADE,
    speaker_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, user_id),
    UNIQUE (meeting_id, speaker_id),
    FOREIGN KEY (speaker_id, meeting_id)
        REFERENCES {{SCHEMA}}.speakers (id, meeting_id) ON DELETE CASCADE
);

-- One row per extracted fact. source_segment_ids and source_text are the
-- provenance contract: a fact with no source is never stored.
--
-- There is no event_time column. A fact's position in time is the meeting's
-- created_at plus start_time within it, both of which are already stored — a
-- third timestamp would be a copy that can disagree.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_facts (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id         BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    fact_type          TEXT   NOT NULL CHECK (fact_type IN ('REQUEST', 'DECISION', 'ACTION_ITEM')),
    content            TEXT   NOT NULL,
    status             TEXT   NOT NULL DEFAULT 'OPEN'
                              CHECK (status IN ('OPEN', 'DONE', 'CANCELLED', 'DEFERRED')),
    -- deadline_text is what was said; deadline_at is only filled when that text
    -- resolves to one date without guessing. Ambiguous stays NULL, never invented.
    deadline_text      TEXT,
    deadline_at        DATE,
    start_time         DOUBLE PRECISION NOT NULL,
    end_time           DOUBLE PRECISION NOT NULL,
    source_segment_ids BIGINT[] NOT NULL,
    source_text        TEXT   NOT NULL,
    embedding          vector(1024),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (cardinality(source_segment_ids) > 0)
);
CREATE INDEX IF NOT EXISTS idx_facts_meeting ON {{SCHEMA}}.meeting_facts (meeting_id);
CREATE INDEX IF NOT EXISTS idx_facts_embedding
    ON {{SCHEMA}}.meeting_facts USING hnsw (embedding vector_cosine_ops);

-- Who plays which part in a fact. Referencing speakers instead of storing names
-- again is what makes "내가 요청한 것" a join rather than a string match.
-- OWNER is not a separate role: the person a task belongs to is its ASSIGNEE.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_fact_participants (
    fact_id    BIGINT NOT NULL REFERENCES {{SCHEMA}}.meeting_facts(id) ON DELETE CASCADE,
    speaker_id BIGINT NOT NULL REFERENCES {{SCHEMA}}.speakers(id) ON DELETE CASCADE,
    role       TEXT   NOT NULL CHECK (role IN ('REQUESTER', 'ASSIGNEE', 'DECIDER')),
    PRIMARY KEY (fact_id, speaker_id, role)
);
CREATE INDEX IF NOT EXISTS idx_fact_participants_speaker
    ON {{SCHEMA}}.meeting_fact_participants (speaker_id, role);

-- Intelligence state is deliberately NOT part of meetings.status: a failed
-- extraction must never make an approved, searchable meeting look broken.
ALTER TABLE {{SCHEMA}}.meetings
    ADD COLUMN IF NOT EXISTS intelligence_state TEXT NOT NULL DEFAULT 'NOT_BUILT'
        CHECK (intelligence_state IN ('NOT_BUILT', 'BUILDING', 'READY', 'FAILED'));
ALTER TABLE {{SCHEMA}}.meetings
    ADD COLUMN IF NOT EXISTS intelligence_error TEXT;
