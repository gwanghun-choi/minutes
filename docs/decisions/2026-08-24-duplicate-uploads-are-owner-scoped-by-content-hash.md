# The same recording, uploaded twice by one account, is one meeting

**Date:** 2026-08-24
**Status:** accepted
**Migration:** `scripts/migrations/012_duplicate_upload_guard.sql`

## Context

Uploading is the only way a meeting is created, and everything downstream of it
is the expensive half of the product: FFmpeg normalization, faster-whisper,
pyannote, BGE-M3 over every chunk, Kiwi, and an OpenAI extraction after
approval. A second upload of a file already analysed spends all of it again and
leaves the account with two meetings it now has to tell apart by hand.

Nothing stopped that. `original_filename` is a label the uploader chose and was
never a key; `stored_filename` is a fresh UUID per request by design. Two
uploads of one recording were simply two meetings.

## Decision

**Identity is `(owner_user_id, SHA-256 of the original bytes)`.** Migration 012
adds `meetings.source_content_hash` — nullable, `CHECK` for 64 lowercase hex —
and a *partial* unique index over the pair, `WHERE source_content_hash IS NOT
NULL`.

**The hash is taken during the write, not after it.** The upload is already
streamed a megabyte at a time so a long recording never sits in memory whole;
`hashlib.sha256().update(chunk)` rides the same loop. No whole-file read, and no
second pass over the disk.

**The check lands before the meeting row.** `api/meetings.py:create_meeting`
looks the digest up, and on a hit removes the file it just wrote and answers
`409` — so no row, no version, and above all no background task. That placement
is the entire value of the feature: a guard that ran after `pipeline.process`
was queued would have saved nothing.

**Owner-scoped, and that is a security property.** The lookup is
`m.owner_user_id = %(auth_uid)s`, deliberately *not* `access.READABLE`. Two
accounts holding the same file get one meeting each, and an accepted share is
not a claim on the bytes: the recipient may upload the same audio as a meeting
of their own. Answering "duplicate" across accounts would tell one account what
another one holds, which is exactly the kind of thing a count or an id leaks.

**The unique index is the guarantee; the SELECT is an optimisation.** Two
concurrent uploads both find nothing and both insert. One survives; the other's
`UniqueViolation` is caught and turned into the same 409, rather than a 500.

**Legacy rows are left alone.** Nothing walks the upload directory to hash
recordings already stored: `source_content_hash` stays NULL on every meeting
that predates this, and a NULL takes part in no comparison. An unknown hash must
never look equal to another unknown hash, which is also why the unique index is
partial.

**Delete frees the bytes.** Deleting a meeting is a hard `DELETE`, so the row
and its hash go together and the same file can be uploaded again. That is the
answer for a `FAILED` meeting too — it is refused as a duplicate and the message
says to delete it first, rather than quietly making a second one.

The 409 body carries `code`, `existing_meeting_id`, `existing_meeting_title`
(this account's own alias, through `organization.DISPLAY_TITLE`), and
`existing_meeting_status`, so the dialog can say which meeting and offer to open
it. It carries neither the hash nor any stored path.

## Rejected

**Global dedup on content alone.** One meeting per distinct recording is fewer
rows and a cross-account information leak: the second uploader would learn, from
a refusal, that somebody else has that file.

**Normalized-PCM or audio-fingerprint identity.** It would catch a re-encode of
the same recording, which byte equality does not. It also needs FFmpeg to have
run — which is the work this exists to avoid — and turns "is this the same file"
into a similarity threshold with false positives that silently discard a real
meeting. Byte equality is the claim the product can actually stand behind.

**Backfilling hashes for existing meetings.** A migration that reads every
stored recording to hash it, on a database holding real audio, for a guard that
only ever needs to work going forward.

**Checking after the insert, or in the pipeline.** Cheaper to write and worth
nothing: the analysis is what costs, and by then it has started.

## Consequences

- `POST /api/meetings` has a second refusal, `409 DUPLICATE_MEETING_SOURCE`, and
  it is the first one that names another resource. `ApiError` on the frontend now
  carries the whole error body so the upload dialog can read it; every other
  caller still reads `detail` alone.
- Re-uploading a deleted meeting works, and re-uploading a `FAILED` one does not
  until it is deleted. Both follow from hard delete and neither is a special case
  in the code.
- Meetings uploaded before this migration will never be recognised as duplicates
  of anything, including of each other.
- `owner_user_id` is NULL on orphan meetings (migration 009), and a unique index
  treats NULLs as distinct, so orphans are nobody's duplicate either.
