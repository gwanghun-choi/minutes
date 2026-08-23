import { Search, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useShareMutations, useShares, useUserSearch } from "../../api/queries";
import type { MeetingShare } from "../../api/types";
import { ShareStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/controls";
import { ErrorState, SkeletonRows } from "../../components/ui/feedback";
import { SHARE_STATUS } from "../../lib/labels";

/**
 * Who else can read this meeting. The owner's panel, and nobody else's.
 *
 * The caller mounts it only for an owner, but that is a drawing decision — the
 * endpoints behind it refuse anybody else, so a shared reader who reached this
 * component would see errors rather than data.
 *
 * A name is what a person types; an account id is what gets stored. The search
 * below sends the id it found, never the text that found it, so two people with
 * the same display name can still be told apart by their username.
 */
export function SharePanel({ meetingId }: { meetingId: number }) {
  const shares = useShares(meetingId, true);
  const { revoke } = useShareMutations(meetingId);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [doomed, setDoomed] = useState<MeetingShare | null>(null);

  const rows = shares.data ?? [];
  // REVOKED and REJECTED rows are history, not access. They stay in the database
  // for the audit trail; showing every one of them here would bury the two
  // states that still mean something.
  const active = rows.filter((r) => r.status === "PENDING" || r.status === "ACCEPTED");
  const past = rows.filter((r) => r.status === "REJECTED" || r.status === "REVOKED");

  return (
    <>
      <div className="space-y-3">
        {shares.isPending ? (
          <SkeletonRows rows={2} />
        ) : shares.isError ? (
          <ErrorState error={shares.error} />
        ) : active.length === 0 ? (
          <p className="text-sm text-fg-muted">
            아직 아무에게도 공유하지 않았습니다. 승인이 끝난 회의만 공유할 수 있습니다.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {active.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{r.display_name}</span>
                  <span className="text-xs text-fg-subtle">{r.username}</span>
                </span>
                <ShareStatusBadge status={r.status} />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X aria-hidden className="size-4" />}
                  onClick={() => setDoomed(r)}
                >
                  {r.status === "PENDING" ? "초대 취소" : "공유 해제"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {past.length > 0 ? (
          <p className="text-xs text-fg-subtle">
            지난 내역:{" "}
            {past.map((r) => `${r.display_name} · ${SHARE_STATUS[r.status]}`).join(", ")}
          </p>
        ) : null}

        <Button
          size="sm"
          icon={<UserPlus aria-hidden className="size-4" />}
          onClick={() => setInviteOpen(true)}
        >
          사용자 초대
        </Button>
      </div>

      {inviteOpen ? (
        <InviteDialog meetingId={meetingId} onClose={() => setInviteOpen(false)} />
      ) : null}

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => !open && setDoomed(null)}
        title={doomed?.status === "PENDING" ? "초대를 취소할까요?" : "공유를 해제할까요?"}
        confirmLabel={doomed?.status === "PENDING" ? "초대 취소" : "공유 해제"}
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (!doomed || revoke.isPending) return;
          revoke.mutate(doomed.invited_user_id, {
            onSuccess: () => {
              toast.success("공유를 해제했습니다.");
              setDoomed(null);
            },
            onError: (err) => toast.error("실패", { description: err.message }),
          });
        }}
        body={
          <>
            <strong className="text-fg">{doomed?.display_name}</strong> 님은 이 회의를 더 이상
            열람할 수 없고, 채팅 검색 범위에서도 즉시 제외됩니다.
          </>
        }
      />
    </>
  );
}

/**
 * Find one account and invite it.
 *
 * The list only appears once something has been typed. That is the endpoint's
 * own rule too — it answers searches, and handing back the whole staff directory
 * to anybody who opened a dialog is not one.
 */
function InviteDialog({ meetingId, onClose }: { meetingId: number; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const found = useUserSearch(term, meetingId);
  const { invite } = useShareMutations(meetingId);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="사용자 초대"
      description="초대한 사용자가 승인해야 회의를 볼 수 있습니다. 읽기와 검색만 가능합니다."
      className="w-[min(28rem,calc(100vw-2rem))]"
      footer={
        <Button size="sm" onClick={onClose}>
          닫기
        </Button>
      }
    >
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="이름 또는 아이디로 검색"
          aria-label="사용자 검색"
          className="w-full pl-8"
        />
      </div>

      <div className="min-h-24 rounded-md border border-border">
        {term.trim() === "" ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">
            초대할 사용자의 이름이나 아이디를 입력하세요.
          </p>
        ) : found.isPending ? (
          <SkeletonRows rows={2} className="p-3" />
        ) : (found.data ?? []).length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">
            일치하는 사용자가 없습니다.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(found.data ?? []).map((u) => {
              // Already invited or already reading it: say so instead of letting
              // the click become a 409.
              const held = u.share_status === "PENDING" || u.share_status === "ACCEPTED";
              return (
                <li key={u.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{u.display_name}</span>
                    <span className="text-xs text-fg-subtle">{u.username}</span>
                  </span>
                  {held ? (
                    <span className="text-xs text-fg-muted">
                      {SHARE_STATUS[u.share_status!]}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={invite.isPending && invite.variables === u.id}
                      onClick={() =>
                        invite.mutate(u.id, {
                          onSuccess: () =>
                            toast.success(`${u.display_name} 님을 초대했습니다.`),
                          onError: (err) =>
                            toast.error("초대 실패", { description: err.message }),
                        })
                      }
                    >
                      초대
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {invite.isError ? <ErrorState error={invite.error} /> : null}
    </Dialog>
  );
}
