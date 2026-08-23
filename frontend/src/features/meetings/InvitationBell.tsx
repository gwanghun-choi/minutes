import clsx from "clsx";
import { Bell } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useInvitations, useRespondToInvitation } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorState, SkeletonRows } from "../../components/ui/feedback";
import { fmtDate } from "../../lib/format";

/**
 * 공유 알림 — an invitation is a notification, not a place.
 *
 * It used to be a top-level destination with its own route, which put a page in
 * the navigation that is empty almost all of the time and reads as somewhere you
 * are supposed to go. What a person actually needs is to be told when one
 * arrives and to answer it where they are, so this is a count in the sidebar and
 * a dialog over whatever screen they were on.
 *
 * A dialog rather than a popover because the app has one modal primitive and no
 * popover one: `Dialog` already owns ESC, the backdrop, focus trapping and
 * returning focus, and it behaves identically at every width — which matters,
 * because below `md` the sidebar is a top bar and an anchored panel would have
 * nothing sensible to anchor to.
 *
 * Nothing from inside the meeting is shown here. Until an invitation is accepted
 * the meeting is unreachable, so this carries exactly what an invitation is: a
 * title, a date, and who sent it.
 */
export function InvitationBell({ onOpen }: { onOpen?: () => void }) {
  const invitations = useInvitations();
  const respond = useRespondToInvitation();
  const [open, setOpen] = useState(false);
  const rows = invitations.data ?? [];
  const pending = rows.length;

  const answer = (id: number, accept: boolean, title: string) =>
    respond.mutate(
      { id, accept },
      {
        onSuccess: () => {
          toast.success(accept ? `${title} 공유를 승인했습니다.` : "초대를 거절했습니다.");
          // The last one answered: nothing left to look at.
          if (pending <= 1) setOpen(false);
        },
        onError: (err) => toast.error("처리 실패", { description: err.message }),
      },
    );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
        aria-label={pending > 0 ? `공유 알림 ${pending}건 대기` : "공유 알림"}
        className={clsx(
          "flex items-center gap-2 rounded px-2 py-1.5 text-[13px] transition-colors",
          pending > 0
            ? "font-medium text-fg hover:bg-surface-muted"
            : "text-fg-muted hover:bg-surface-muted hover:text-fg",
        )}
      >
        <Bell aria-hidden className="size-4 shrink-0" />
        공유 알림
        {pending > 0 ? (
          <span className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium tabular-nums text-primary-fg">
            {pending}
          </span>
        ) : null}
      </button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="공유 알림"
        description="승인하기 전에는 회의를 열람할 수 없습니다."
      >
        {invitations.isPending ? (
          <SkeletonRows rows={2} />
        ) : invitations.isError ? (
          <ErrorState error={invitations.error} />
        ) : pending === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">받은 공유 초대가 없습니다.</p>
        ) : (
          <ul className="-mx-1 max-h-[50vh] divide-y divide-border overflow-y-auto px-1">
            {rows.map((r) => (
              <li key={r.id} className="py-3">
                <p className="text-sm text-fg">
                  <strong className="font-medium">{r.shared_by}</strong> 님이{" "}
                  <strong className="font-medium">“{r.meeting_title}”</strong> 을(를)
                  공유했습니다.
                </p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  회의일{" "}
                  {r.held_at_known ? (
                    fmtDate(r.occurred_at)
                  ) : (
                    <span className="text-fg-subtle">{fmtDate(r.occurred_at)} 등록</span>
                  )}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    onClick={() => answer(r.id, false, r.meeting_title)}
                    disabled={respond.isPending}
                  >
                    거절
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => answer(r.id, true, r.meeting_title)}
                    disabled={respond.isPending}
                  >
                    수락
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
