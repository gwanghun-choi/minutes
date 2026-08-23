import clsx from "clsx";
import { Bell } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useInvitations, useRespondToInvitation } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Popover } from "../../components/ui/Popover";
import { ErrorState, Spinner } from "../../components/ui/feedback";
import { fmtDate } from "../../lib/format";

/**
 * 공유 알림 — an invitation is a notification, not a place.
 *
 * It was a top-level destination with its own route first, which put a page in
 * the navigation that is empty almost all of the time; then a row in the sidebar
 * navigation, which still read as somewhere to go. It is neither. It is a thing
 * that arrived from another account while you were doing something else, so it
 * is a count in the top-right corner of every screen and a panel hanging off it.
 *
 * A popover rather than a dialog, and that is the change: answering an
 * invitation should not take over the screen or ask to be finished. The page
 * behind stays readable and scrollable, and looking away dismisses it. Radix
 * owns Escape, the outside click, focus moving in and back to the bell, and
 * keeping the panel on screen near a corner.
 *
 * Nothing from inside the meeting is shown. Until an invitation is accepted the
 * meeting is unreachable, so this carries exactly what an invitation is: a
 * title, a date, and who sent it.
 */
export function InvitationBell() {
  const invitations = useInvitations();
  const respond = useRespondToInvitation();
  // Controlled for one reason: answering the last invitation should close the
  // panel rather than leave an empty box hanging off the bell.
  const [open, setOpen] = useState(false);
  const rows = invitations.data ?? [];
  const pending = rows.length;

  const answer = (id: number, accept: boolean, title: string) =>
    respond.mutate(
      { id, accept },
      {
        onSuccess: () => {
          toast.success(accept ? `${title} 공유를 승인했습니다.` : "초대를 거절했습니다.");
          if (pending <= 1) setOpen(false);
        },
        onError: (err) => toast.error("처리 실패", { description: err.message }),
      },
    );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="공유 알림"
      trigger={
        <button
          type="button"
          aria-label={pending > 0 ? `공유 알림 ${pending}건 대기` : "공유 알림"}
          className={clsx(
            "relative inline-flex size-8 items-center justify-center rounded-md",
            "text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg",
            "data-[state=open]:bg-surface-muted data-[state=open]:text-fg",
          )}
        >
          <Bell aria-hidden className="size-4" />
          {/* Absent at zero rather than a grey 0: a badge is an interruption,
              and "nothing is waiting" is not one. */}
          {pending > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold tabular-nums text-primary-fg">
              {pending}
            </span>
          ) : null}
        </button>
      }
    >
      <p className="border-b border-border bg-surface-muted px-3.5 py-2 text-[11px] text-fg-muted">
        승인하기 전에는 회의를 열람할 수 없습니다.
      </p>

      {invitations.isPending ? (
        <p className="flex items-center justify-center gap-2 px-3.5 py-8 text-xs text-fg-muted">
          <Spinner /> 불러오는 중…
        </p>
      ) : invitations.isError ? (
        <div className="p-3">
          <ErrorState error={invitations.error} />
        </div>
      ) : pending === 0 ? (
        <div className="px-3.5 py-8 text-center">
          <p className="text-[13px] text-fg-muted">받은 공유 초대가 없습니다.</p>
          <p className="mt-1 text-[11px] text-fg-subtle">
            다른 사용자가 회의를 공유하면 여기에 표시됩니다.
          </p>
        </div>
      ) : (
        <ul className="max-h-[min(24rem,60vh)] divide-y divide-border overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id} className="px-3.5 py-3">
              <p className="text-[13px] leading-5 text-fg">
                <strong className="font-medium">{r.shared_by}</strong> 님이{" "}
                <strong className="font-medium">“{r.meeting_title}”</strong> 을(를)
                공유했습니다.
              </p>
              <p className="mt-0.5 text-[11px] text-fg-subtle">
                회의일{" "}
                {r.held_at_known
                  ? fmtDate(r.occurred_at)
                  : `${fmtDate(r.occurred_at)} 등록`}
              </p>
              <div className="mt-2 flex items-center justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
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
    </Popover>
  );
}
