-- Idempotent. Scoped entirely to the {{SCHEMA}} schema; never touches other schemas.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS {{SCHEMA}};

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meetings (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title             TEXT        NOT NULL,
    original_filename TEXT        NOT NULL,
    stored_filename   TEXT        NOT NULL,
    duration          DOUBLE PRECISION,
    language          TEXT,
    status            TEXT        NOT NULL DEFAULT 'UPLOADED',
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.speakers (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id   BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    speaker_code TEXT   NOT NULL,
    display_name TEXT,
    UNIQUE (meeting_id, speaker_code)
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.transcript_segments (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    speaker_id BIGINT REFERENCES {{SCHEMA}}.speakers(id) ON DELETE SET NULL,
    sequence   INTEGER NOT NULL,
    start_time DOUBLE PRECISION NOT NULL,
    end_time   DOUBLE PRECISION NOT NULL,
    text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_meeting ON {{SCHEMA}}.transcript_segments (meeting_id, sequence);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.chunks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id    BIGINT NOT NULL REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    sequence      INTEGER NOT NULL,
    content       TEXT   NOT NULL,
    start_time    DOUBLE PRECISION NOT NULL,
    end_time      DOUBLE PRECISION NOT NULL,
    speaker_codes TEXT[] NOT NULL DEFAULT '{}',
    embedding     vector({{DIM}})
);
CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON {{SCHEMA}}.chunks (meeting_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON {{SCHEMA}}.chunks USING hnsw (embedding vector_cosine_ops);
