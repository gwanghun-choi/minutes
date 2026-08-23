# 삭제 means two things, and a shared reader's is their own access

**Date:** 2026-08-24
**Status:** accepted
**Migration:** none

## Context

A meeting reached a reader in exactly one way — the owner invited them and they
accepted — and left in exactly one way: the owner took it back, or deleted the
meeting. The reader had no door of their own. A share they no longer wanted sat
on their list, in their sidebar, in their counts, and inside every unscoped
retrieval they ran, and the only thing they could do about it was ask the owner.

The obvious control to reach for is the one already on the row menu: 삭제. It
cannot mean what it means for the owner. `DELETE /api/meetings/{id}` removes the
recording, the minutes, the index, the insights and *everybody else's* access,
and `access.require_owner` refuses it from a shared reader — correctly, and
that is not the thing to relax.

## Decision

**Two endpoints, one word.** `DELETE /api/meetings/{id}` stays exactly what it
was. `DELETE /api/meetings/{id}/shares/me` is the reader's, and it removes their
own ACCEPTED row from `meeting_shares` and nothing else. The label on both is
삭제, because the reader's intent is the same in both cases — get this off my
screen — and the confirmation dialog is where they part: one says the recording
and the minutes are going, the other says 내 회의 목록에서만 삭제됩니다.

**The row is deleted, not moved to a new status.** REVOKED is the owner's word
for the owner's act, carries `revoked_at`, and is what their 공유 panel shows.
Writing it from the reader's side would tell an owner they withdrew something
they did not. An accepted invitation that is handed back leaves nothing to
record, and a later re-invitation is then an ordinary INSERT on a row that is
gone.

**The caller's own filing and speaker mapping go with it** —
`user_meeting_filing` and `meeting_user_speakers`, both scoped by `user_id` in
the same transaction. They describe a meeting this account can no longer reach,
so no screen could ever show or remove them again. Neither ever granted
anything: `access.READABLE` is still the only door, and it now says no.

**The owner is refused this endpoint** (403), for the same reason the reader is
refused the other one. An account that cannot read the meeting gets 404, so the
id says nothing.

**Nothing in the action matrix widens.** 검색 인덱스 다시 생성 re-embeds the
canonical meeting for every reader of it, so it stays the owner's — refused by
`access.require_owner` and no longer drawn for a shared reader, who was only
ever being offered a refusal.

## Rejected

- **A fifth `meeting_shares.status`** (`LEFT`, `RELEASED`). It needs a migration
  to widen a CHECK, and it buys a distinction nobody reads: the owner's panel
  would have to explain a state that means "not shared", which is what an absent
  row already means.
- **Reusing REVOKED.** No migration, and a lie in the one place the owner looks.
- **Hiding the shared reader's 삭제 entirely** and telling them to ask the owner.
  That is the state this record exists to end.
- **Letting the canonical DELETE branch on role.** One endpoint whose blast
  radius depends on who is calling is the shape that produces a deleted
  recording after a permission check moves.
- **Keeping the reader's filing and alias.** Invisible rows nobody can reach,
  which would also silently come back if the owner re-invited them.

## Consequences

Access can now end from either side, and both ends read the same predicate, so
the list, the detail page, the transcript, the stored evidence and all four
retrieval paths agree on the next request without anything being cleaned up.

An owner loses the record that a particular person once accepted, in the case
where that person left. `responded_at` on a REVOKED row still says it for the
case the owner ended.

A reader who leaves and is re-invited comes back with no alias and no folder;
their arrangement was deleted with their access.

The frontend has one 삭제 for three surfaces — the list, the sidebar tree, and
the detail header — in `features/meetings/DeleteMeeting.tsx`, and the meeting
detail page no longer has a 관리 panel: its two actions are in the header, and
삭제 is only in the `⋯`.
