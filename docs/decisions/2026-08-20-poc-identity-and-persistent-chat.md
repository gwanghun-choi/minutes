# POC identity, persistent chat, and explicit chat scope

**Date:** 2026-08-20
**Status:** accepted

## Context

Three things forced a choice at once, and they share one root.

The application had no notion of a user. Chat was a single stateless
`POST /api/chat`: no history, no way to continue a thought, and nothing to
attribute a conversation to. Adding persistent chat therefore required deciding
who owns a conversation before deciding how to store it.

The meeting selector was a `<select>` listing every `COMPLETED` meeting. That
stops working as meetings accumulate, and it also could not express "these three
meetings", which is what a real question about a project needs.

And a scoped search raised a correctness question the old code never had to
answer: when the chosen meetings contain no answer, may the system look
elsewhere? Answering from a meeting the user excluded is not a convenience — it
silently changes what the answer is evidence *of*.

This is the first persistence in the repository that is not derived from an
audio file, and the first request-time authorization of any kind, so it is
recorded here rather than in the work log.

## Decision

**Identity is a boundary for chat history, and nothing else.** `users`,
`scrypt` password hashes from the stdlib, and opaque tokens in `auth_sessions`.
One `require_login` middleware in `app/main.py` closes every route except
`/health`, `/login`, `POST /api/auth/login`, and `/static/*`. Meetings stay
visible to every logged-in user; only chat sessions are owned, enforced by
`user_id` appearing in every chat query.

The first account is created at startup from `MINUTES_BOOTSTRAP_USERNAME` /
`MINUTES_BOOTSTRAP_PASSWORD` with `ON CONFLICT DO NOTHING`.

> **Superseded on 2026-08-21** by
> [2026-08-21-explicit-db-migration-and-db-managed-identity.md](2026-08-21-explicit-db-migration-and-db-managed-identity.md).
> Accounts now live only in `minutes.users`, seeded by a migration; the two
> environment variables and the startup bootstrap no longer exist. Everything
> else in this record still holds.

**Chat is two tables.** `chat_sessions` (owner, title, scope, timestamps) and
`chat_messages` (role, content, `sources JSONB`). Storing the serialized sources
with the assistant message is what lets a reopened chat show the same evidence,
including for meetings whose speaker names have since changed.

**Scope is one array column.** `chat_sessions.scope_meeting_ids BIGINT[]`, where
empty means the whole corpus. `rag.search` applies it as
`c.meeting_id = ANY(...)`.

**A scoped miss is reported, never resolved.** The response carries
`scope_miss`; widening requires a second request with `global_override`, which
applies to that one question and leaves the session's scope untouched. The miss
signal is `rag.NO_ANSWER` — the same sentence the evidence prompt already tells
the model to produce.

**Conversation memory is the last `rag.HISTORY_MESSAGES` messages, verbatim**,
passed to the generator between the system prompt and the evidence.

**Summaries are one row per meeting**, `meeting_summaries` keyed by `meeting_id`,
so regeneration is an upsert and deletion is the existing cascade.

## Rejected

**A session secret and signed cookies.** Would have added a secret to configure,
rotate, and leak, and made logout a client-side hope. A row in `auth_sessions` is
the authority instead, and deleting it is genuinely a logout.

**bcrypt / argon2 / passlib.** A new dependency for something `hashlib.scrypt`
does. `scrypt` is memory-hard and its parameters travel with each hash.

**JWT, OAuth/OIDC, MS SSO, RBAC, meeting ownership.** None of them separate one
person's chat history from another's, which is the entire requirement.

**A `scope` enum column plus a `chat_session_meetings` join table.** Two objects
to express what one array already says: the states differ only by whether ids are
listed. The array carries no foreign key, which is the accepted cost — a chat
naming a deleted meeting retrieves nothing from it.

**Automatic global fallback on a miss.** Rejected as a correctness failure. The
user would have no way to tell an answer from their chosen meetings apart from an
answer from a meeting they deliberately excluded.

**A relevance threshold to decide "miss".** A second, differently-tuned judge for
a question the evidence prompt already answers.

**An LLM call to title a chat.** A truncated first question is a sidebar label,
not a summary.

**Conversation summarization or a memory store.** A bounded window of recent
turns is enough at this scale, and unlike summarization it cannot invent context.

**Query rewriting for follow-up questions.** It would improve retrieval on "그
부서는?", but it is a second LLM call *and* a change to retrieval semantics.
Recorded as a known limitation instead.

**Persisting correction suggestions.** They are a proposal in the browser; the
existing transcript `PATCH` is what makes an edit real.

**A `<select>` with multi-select, and a modal library.** The picker needs search
and a date filter; both are a few lines of vanilla JS over the existing
`GET /api/meetings`.

## Consequences

Every route is closed by default, so a new endpoint is protected without anyone
remembering to protect it. The cost is that every automated caller now needs a
session — the test suite logs in, and `tests/conftest.py` carries that.

Chat history and its evidence survive a restart, which analysis progress still
does not. That asymmetry is deliberate: chat is user data, analysis progress is
a job.

Scope is honest. A scoped answer is evidence from exactly the meetings the user
named, and widening is always visible in the transcript of the conversation.

Nothing invalidates existing data. No column changed meaning, no vector was
touched, chunking and the embedding model are unchanged, and every existing
meeting behaves as it did.

The login is an identity boundary and not transport security. The deployment is
plain HTTP, so the cookie is not `secure`; HTTPS termination is still required
before this is exposed beyond a trusted network.
