# Explicit DB migration, and accounts owned by the database

**Date:** 2026-08-21
**Status:** accepted

## Context

Two habits from the MVP were about to be carried into a real deployment.

**Startup applied DDL.** `app/main.py` ran `scripts/init_db.sql` through
`db.apply_schema()` on every boot. It was idempotent and it worked, but it makes
schema change a side effect of starting a process. Every container start held
write authority over a database shared with other applications; a schema mistake
would be discovered by a restart rather than by a deployment step; and there was
no record anywhere of which version of the schema a given database was at. It
also inverts the deployment order: the new container would have had to be
started in order to apply the schema it needs.

**Accounts came from environment variables.** `MINUTES_BOOTSTRAP_USERNAME` /
`MINUTES_BOOTSTRAP_PASSWORD` created the first user at startup. That makes the
process configuration a user store: the credential exists in a deploy
environment, adding a second account is impossible, an account cannot be
disabled, and nothing records who logged in when. The `users` table was also
thinner than it needed to be — it had no display name and no notion of an
inactive account, so the only way to stop someone logging in was to delete the
row and their whole chat history with it.

The trigger is the first NCP deployment of this schema against a database that
already holds real meetings.

## Decision

**Schema is a deployment step.** `scripts/migrations/*.sql` applied by
`python -m scripts.migrate`. Nothing under `app/` issues DDL. Application startup
calls `migrate.verify()`, which is read-only: it refuses to serve a database that
is not fully migrated, and refuses one whose vector column disagrees with the
loaded embedding model. It never repairs anything.

**The runner is ~110 lines of psycopg, not a framework.** Files are applied in
filename order, each inside one transaction together with the
`schema_migrations` row recording it. A failure rolls back and records nothing,
so the next run retries the same file rather than skipping it.

**Migrations only add.** The three files that exist are `IF NOT EXISTS` and
`ADD COLUMN IF NOT EXISTS` throughout. A database that already has the core
tables records `001` without changing a row — which is exactly the deployed case.

**The vector width is a literal in the migration**, `vector(1024)`, rather than a
value read from the embedding model at apply time. A migration records what was
built. Changing `EMBEDDING_MODEL` is a new migration plus re-embedding, and
`verify()` catches the mismatch in the meantime.

**`minutes.users` is the source of truth for accounts.** `users` gains
`display_name`, `is_active`, `updated_at`, and `last_login_at`. `users.id` stays
the internal `BIGINT` key referenced by `auth_sessions` and `chat_sessions`;
`users.username` is what a person types on the login form. The POC account
(`user` / `user1234`) is seeded by migration `003` from a precomputed scrypt
hash, guarded by `WHERE NOT EXISTS` — never `ON CONFLICT DO UPDATE`, which would
reset a password someone had changed.

**`is_active` is enforced in `resolve_session`, not only at login.** The
existing session query gains `AND u.is_active`, so deactivating an account closes
the sessions it already handed out. `last_login_at` is written on success only.

## Rejected

- **Alembic, or any migration framework.** It brings a dependency, a revision
  graph, autogeneration against an ORM this repository does not have, and a
  second way to express DDL. Three SQL files and a version table cover the whole
  requirement.
- **Keeping `init_db.sql` alongside the migrations.** Two copies of the same DDL
  is two sources of truth; the file was deleted once its content moved.
- **A migration container or an entrypoint that migrates before `uvicorn`.**
  That is the same coupling wearing a different hat — a container start would
  still mutate the schema. The deployment runs one command and checks it.
- **Down migrations.** Reversing a schema change is a new forward migration.
  Untested rollback SQL is worse than none.
- **`CREATE SCHEMA` / DDL in the application with a "first run only" flag.** A
  flag is state that can be wrong; the version table already answers the
  question, and only the runner writes it.
- **UUID primary keys for `users`.** Nothing needed them. `BIGINT GENERATED
  ALWAYS AS IDENTITY` matches every other table and the two foreign keys already
  pointing at it.
- **Storing the POC password in the environment, or hashing it at startup.** Both
  keep a plaintext credential somewhere the application can read. The migration
  stores a hash and nothing else.
- **A `roles`/`permissions` table while the schema was open.** Meetings still
  have no ownership; adding an authorization model nobody asked for would be a
  boundary change, not a migration.
- **A `session_revocations` table.** `is_active` in the one query every request
  already runs does the same work with no new table.
- **An `updated_at` trigger.** Nothing updates user rows yet. A trigger on every
  table is a framework for a problem that does not exist.
- **Deleting the schema and re-creating it in tests.** The configured schema
  holds real meetings. Migration tests build a throwaway `minutes_test_*` schema
  and drop that.

## Consequences

Deployment gains a step and an order that cannot be skipped: build, migrate,
then start. Forgetting it is not a subtle failure — the application refuses to
start and says which versions are missing.

Rolling back the application no longer rolls back the schema. This is safe
today because every migration only adds, so an older build runs unchanged
against a newer database; it stops being automatically true the first time a
migration removes or renames something.

Accounts become manageable data: a second user is an `INSERT`, disabling one is
`is_active = false` and takes effect on their next request, and `last_login_at`
records use. There is still no UI for any of it, so those are DB operations.

`user` / `user1234` is a publicly known credential in a public repository. It is
a POC requirement and is documented as one, but the deployment is not safe to
expose until it is changed — and there is no password-change screen yet.

The two environment variables are gone. Any `.env` still setting them is simply
ignored.
