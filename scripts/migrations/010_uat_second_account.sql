-- A second account, so ownership and sharing can be exercised by two people.
--
-- Migration 003 created the first account the same way and for the same reason:
-- accounts belong in the database, not in environment variables, and a seed that
-- runs exactly once is what keeps a re-run from resetting somebody's password.
--
-- The literal below is a scrypt hash produced by app.services.auth.hash_password
-- — the same function the login form verifies against. The plaintext is never
-- stored, never appears in this repository, and never reaches the database.
--
-- WHERE NOT EXISTS, deliberately not ON CONFLICT DO UPDATE: if this username is
-- already taken its password belongs to whoever set it. Re-running the migration
-- runner, restarting the application, or applying this to a database that
-- already has the account all change nothing.
--
-- This is a development and UAT account for the two-user permission tests, not a
-- default credential the product ships. It is an ordinary row in `users` with no
-- role, no flag, and no special path through the code — deactivate it with
-- `UPDATE users SET is_active = false WHERE username = 'user2'` and every session
-- it holds stops resolving on the next request.
INSERT INTO {{SCHEMA}}.users (username, password_hash, display_name)
SELECT 'user2',
       'scrypt$16384$8$1$780652c2a2b1f8e9c0c42569c2547983$58217fcabad9e67f6512cbce3a1fa55885fc027b045b67aa389e58317b2e81f9',
       '테스트 사용자 2'
WHERE NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.users WHERE username = 'user2');
