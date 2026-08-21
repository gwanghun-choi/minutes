-- Productization Wave 1: identity, chat history, meeting summaries.

-- Username/password only. No roles, no per-meeting permission: the boundary
-- these tables draw is chat ownership, nothing else.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The cookie carries only this opaque id; the row is the whole authority, so a
-- forged cookie resolves to nothing and logout is a DELETE.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.auth_sessions (
    id         TEXT   PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- scope_meeting_ids: empty array = GLOBAL. One array column instead of a scope
-- enum plus a join table - the two states differ only by whether ids are listed.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.chat_sessions (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES {{SCHEMA}}.users(id) ON DELETE CASCADE,
    title             TEXT   NOT NULL DEFAULT '새 채팅',
    scope_meeting_ids BIGINT[] NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user
    ON {{SCHEMA}}.chat_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.chat_messages (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES {{SCHEMA}}.chat_sessions(id) ON DELETE CASCADE,
    role       TEXT   NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT   NOT NULL,
    sources    JSONB  NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session
    ON {{SCHEMA}}.chat_messages (session_id, id);

-- meeting_id is the primary key: one summary per meeting, regenerate is an
-- upsert, and the cascade removes it with the meeting.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.meeting_summaries (
    meeting_id BIGINT PRIMARY KEY REFERENCES {{SCHEMA}}.meetings(id) ON DELETE CASCADE,
    content    TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
