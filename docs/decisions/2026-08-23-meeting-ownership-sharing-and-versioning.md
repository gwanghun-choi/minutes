# Meeting ownership, invitation sharing, and minutes versioning

**Date:** 2026-08-23
**Status:** accepted
**Migrations:** `009_meeting_ownership_sharing_versions`, `010_uat_second_account`

## Context

Until now a meeting belonged to the installation, not to a person. `users`,
`auth_sessions`, and `chat_sessions` existed and the login was real, but the only
ownership rule in the system was over chat sessions — AGENTS.md said so
explicitly: *"This is the only ownership rule in the system; meetings
deliberately have none."* Any logged-in account could list, read, edit, approve,
re-index, and delete any meeting, and retrieval searched every approved meeting
in the database regardless of who was asking.

That was defensible for a single-account POC. It is not defensible the moment two
people use it, and three requirements arrived together that all turn on the same
missing fact:

1. a recording is personal, and must be invisible to everyone else;
2. a person must be able to hand one meeting to one colleague, deliberately, and
   take it back;
3. an approved transcript must be correctable without going out of search while
   the correction is being written.

They are three features and one model. Ownership is what a share modifies; a
share is what decides whose retrieval a meeting is in; and a version is what
lets the thing being shared change without the reader's answers breaking. Adding
them separately would have produced three permission checks that could disagree.

## Decision

### One access predicate, pasted everywhere

`app/services/access.py` holds the whole rule as SQL over a `meetings m` alias:

```sql
m.owner_user_id = %(auth_uid)s
OR EXISTS (SELECT 1 FROM meeting_shares sh
            WHERE sh.meeting_id = m.id
              AND sh.invited_user_id = %(auth_uid)s
              AND sh.status = 'ACCEPTED')
```

Every list query, every detail read, the category counts, and all four retrieval
paths paste that same text. This is the discipline `categories.SUBTREE` already
established for "descendant": a rule that appears twice will eventually mean two
things, and for an access rule the second meaning is a leak.

Two roles, no matrix: `OWNER` (everything) and `SHARED_READ` (read and chat).
There is no permission level to choose when inviting, so there is nothing to
mis-configure, and no editing right that can be granted by accident.

**Rejected: a `meeting_permissions` table with a role column, or a role/ACL
matrix.** Two states do not need a table of roles, and a role column is an
invitation to add `EDITOR` without thinking about what an editor does to an index
other people are searching. When a third role earns its keep it is a migration
and a decision record, not a value in an existing enum.

**Rejected: 403 for an unreadable meeting.** A meeting you may not read answers
404 at every endpoint, identical to an id that was never issued — otherwise the
id space is an oracle for how many meetings other people have. 403 is used only
where the caller already knows the meeting exists: a shared reader attempting an
owner action, where 403 says the true reason and reveals nothing new.

### Ownership is nullable, and an orphan is invisible

`meetings.owner_user_id` is a nullable FK with `ON DELETE SET NULL`.

Nullable because the deployed database holds meetings uploaded before this
migration and their uploader is not recorded anywhere. The backfill fills in only
what the data proves — an account that claimed a speaker in that meeting
(`meeting_user_speakers`, a deliberate act by a logged-in person on that one
meeting), or, failing that, the single active account in a one-account database,
which is a fact rather than a guess. Anything left NULL stays NULL.

The predicate is a plain equality, so a NULL owner matches nobody: an orphan is
readable by no one rather than by everyone. That is the direction a missing
answer has to fail in, and it is what makes the nullable column safe.

**Rejected: `NOT NULL` after the backfill.** A conditional `SET NOT NULL` would
make the schema differ between databases depending on their data, so a fixture
that passes here fails there. An unconditional one would refuse to migrate a
database with an unprovable orphan — turning a data question into a deployment
outage. The application supplies the owner on every insert; the constraint is
worth adding in a later migration once no NULLs remain, and that is a separate,
observable step.

**Rejected: `ON DELETE CASCADE` from `users`.** Removing an account must never
delete the recordings and approved minutes it owned. An orphan is recoverable by
an operator with one `UPDATE`; a cascade is not recoverable at all.

### Sharing is an invitation to one account, by id

`meeting_shares` is one row per `(meeting_id, invited_user_id)` for the life of
that relationship, with `PENDING → ACCEPTED | REJECTED` and `→ REVOKED`. Only a
`COMPLETED` meeting can be offered: a draft is unreviewed AI output, and handing
it over would publish a transcript nobody has checked under the same UI that
presents approved minutes.

Re-inviting after a refusal or a revoke reopens the same row rather than adding a
second one. A person is either invited to a meeting or not; two rows would make
"may they read it" a question about which row wins. The timestamps
(`created_at`, `responded_at`, `revoked_at`, `invited_by_user_id`) are the audit
trail, which is also why a revoke is a status and not a `DELETE`.

The permission is `users.id`. A display name is a label that can change and can
repeat; only the id identifies an account. `GET /api/users?q=` exists solely so a
person can type a name and the browser can send an id — it answers a search,
never a browse, and an empty term returns nothing rather than the staff list.

Two rules are constraints rather than code: `UNIQUE (meeting_id,
invited_user_id)` refuses a duplicate invitation, and `CHECK (invited_user_id <>
invited_by_user_id)` refuses inviting yourself — the sharer is always the owner,
so that one constraint is the whole rule.

**Rejected: share links, tokens, or anonymous access.** A link is a credential
that cannot be taken back from whoever forwarded it. Revocation here is a status
change that the next request already evaluates.

### Revocation is immediate everywhere, including in history

Nothing caches the predicate, so a revoke ends access on the next request at the
list, the detail page, the transcript, every version, the intelligence panel, and
all four retrieval paths at once.

`chat_messages.sources` needed a decision of its own. It stores a *snapshot* of
the retrieved transcript words, which is what makes an old answer checkable
without re-reading the meeting — and would also keep the minutes readable in a
chat history forever after a revoke. So stored sources are filtered on read:
inaccessible ones keep their `[N]` and lose everything else (text, meeting,
speakers, link), and the card says why it is blank.

The answer prose itself is not rewritten. It is the record of a conversation that
account really had, at a time when it really could see those meetings, and
silently editing what a person was told is a worse failure than leaving a
paragraph that quotes something they can no longer open. This is a stated limit,
not an oversight — see "Limits".

### A correction is a new version, not an edit

`meeting_versions` carries `DRAFT → INDEXING → PUBLISHED → SUPERSEDED`, and
`transcript_segments`, `chunks`, and `meeting_facts` each gained a `version`
column. Every transcript version is kept; `chunks` and `meeting_facts` only ever
hold the published one and are rebuilt on every publish.

The guarantee is structural rather than careful. Embeddings are computed *before*
the transaction opens; that one transaction deletes the old chunks, inserts the
new ones, and flips the version rows together. There is no window where the old
index is gone and the new one has not arrived, and a failure anywhere leaves the
previously published version and its index untouched and still answering.

Two things follow that are easy to get wrong:

- **`meetings.status` stays `COMPLETED` for the whole revision.** It is a
  retrieval predicate (`m.status = 'COMPLETED'` in both layers), so borrowing it
  to mean "a revision is being indexed" would take the published version out of
  search for the duration — exactly the outage this design exists to prevent. The
  revision's state lives on the version row.
- **Two partial unique indexes carry the invariants**, so no code has to check
  them: at most one `PUBLISHED` version per meeting, and at most one open
  (`DRAFT` or `INDEXING`) one. "Which version is searched" cannot have two
  answers, and a second "회의록 수정" click cannot fork the minutes.

`POST /api/meetings/{id}/approve` publishes both the first draft and every later
revision, because they are the same act — a person saying these minutes are
correct. What differs is only whether anything is published yet, and that decides
whether the meeting status moves.

**Rejected: overwriting the approved transcript in place.** `chunks.content` and
`meeting_facts.source_text` quote it, and `chat_messages.sources` stores what was
quoted. Rewriting it makes every stored citation refer to words that were never
said in that form.

**Rejected: a version number on `meetings` with no history table.** It answers
"which one" and nothing else — not when, not who, not what the previous one said,
which is the provenance the whole retrieval layer is built on.

**Rejected: versioning `speakers` too.** A speaker is the same person across
revisions, and `meeting_user_speakers` and `meeting_fact_participants` both point
at that identity; per-version speakers would mean rewriting two foreign keys to
solve a labelling question. Renaming a speaker is a correction to how they are
labelled, and it rides along with the revision that contains it. The ceiling is
recorded at the code site in `app/services/versions.py`.

**Rejected: rollback to an earlier version.** Out of scope, and the structure
allows it later: a rollback is a new version whose transcript is copied from an
old one, which is `create_draft` with a different source.

### Sharing is on the meeting, versions are what it shows

A share grants access to a *meeting identity*. When the owner publishes v2, every
accepted reader moves to v2 with no new invitation — the share row is untouched.
What a reader sees is always the current published version, and a draft is never
visible to them: `GET /api/meetings/{id}` ignores `?version=` for a shared reader
rather than refusing it, because there is nothing to choose between.

### Categories stay a shared vocabulary; their counts do not

Meetings became owned assets. Categories did not.

A category is a label — a word in a naming vocabulary — and holds nothing about a
meeting beyond what somebody called a folder. Making the tree per-account would
mean a copy of every name per user, an assignment rule for a shared meeting filed
under the owner's label, and dropping the global `UNIQUE` that keeps a rendered
path ("업무 / 개발") unambiguous — all to protect a word.

What *was* leaking is the counts: `meeting_count` said how many meetings in the
whole database wore a label, which told every account how much everybody else
had. Every count is now taken over the meetings the caller may read, through the
same predicate, so the number beside a category always describes the list that
category opens.

Limit, stated rather than hidden: category *names* remain visible to every
account. See "Limits".

### A second seeded account

`010_uat_second_account` adds `user2` the same way `003_user_identity` added
`user`: a precomputed scrypt hash from `app.services.auth.hash_password`, guarded
by `WHERE NOT EXISTS`. Ownership and sharing cannot be exercised, by a person or
by a test, with one account. It is an ordinary row with no role and no special
path through the code, and deactivating it is one `UPDATE`.

## Consequences

- Every `/api/meetings/*` endpoint now takes the caller into account. A new
  endpoint that forgets `access.require_read` / `access.require_owner` is a
  defect, and `tests/test_ownership.py` parametrizes the whole endpoint list so a
  new one that forgets is caught by adding it to that list.
- `rag.search*` and `intelligence.search*` take `user_id`. `None` means "no
  account filter" and exists only for `scripts/evaluate.py`, which owns a
  throwaway schema with no accounts in it. Every application path passes a real
  account.
- Retrieval semantics are unchanged. Dense, lexical, RRF fusion, metadata boost,
  fact retrieval, temporal ordering, conflict detection, and citation validation
  are all exactly as they were; the only difference is which meetings are
  candidates. No evaluation number moves for a single-account corpus.
- The first migration to require the backfill to be *thought about* on the
  deployed database. An operator with more than one account and no speaker
  mappings will find their legacy meetings orphaned and invisible, and must
  assign them deliberately.

## Limits

- `chat_messages.content` — the answer text — is not redacted after a revoke. The
  evidence behind it is, and the meeting is unreachable, but a sentence the model
  wrote may still paraphrase what it read. Redacting prose a person was already
  shown is a different and worse trade.
- Category names are visible to every account, as they were before this change.
- `owner_user_id` is nullable, so the database does not yet refuse an ownerless
  meeting. The application supplies it on every insert and the predicate fails
  closed; the constraint is a later migration.
- A speaker renamed inside an open draft is relabelled in the published version's
  source cards too, because names are resolved at read time while chunk text was
  rendered at index time. Publishing the draft makes them agree again.
