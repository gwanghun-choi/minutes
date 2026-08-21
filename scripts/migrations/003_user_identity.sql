-- The database becomes the source of truth for accounts. Until now the first
-- account came from MINUTES_BOOTSTRAP_USERNAME/PASSWORD at application startup;
-- environment variables are configuration, not a user store.

-- users.id stays the internal BIGINT primary key referenced by auth_sessions and
-- chat_sessions. users.username is what a person types on the login form.
ALTER TABLE {{SCHEMA}}.users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '사용자';
ALTER TABLE {{SCHEMA}}.users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE {{SCHEMA}}.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE {{SCHEMA}}.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- The POC account. The literal below is a scrypt hash of the documented POC
-- password, produced by app.services.auth.hash_password - the plaintext is never
-- stored and never reaches the database.
--
-- WHERE NOT EXISTS, deliberately not ON CONFLICT DO UPDATE: if this username
-- already exists its password belongs to whoever set it, and a re-run must not
-- reset it. The migration version record is the first defence; this is the second.
INSERT INTO {{SCHEMA}}.users (username, password_hash, display_name)
SELECT 'user',
       'scrypt$16384$8$1$ccbfc94718050365cb1bc2d8f9d4fb0e$a11b89a1e0639a675eb86ba02473ab3273528f573bf010234549935e4b6eed60',
       '사용자'
WHERE NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.users WHERE username = 'user');
