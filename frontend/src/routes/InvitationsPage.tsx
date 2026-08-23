import { Inbox } from "lucide-react";
import { toast } from "sonner";

import { useInvitations, useRespondToInvitation } from "../api/queries";
import { PageHeader } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "../components/ui/feedback";
import { fmtDate } from "../lib/format";

/**
 * Meetings other people have offered me.
 *
 * Only PENDING rows: an accepted invitation is a meeting and belongs on the
 * 공유받은 회의 list, and a refused one is over. Until one is accepted the
 * meeting itself is unreachable — this page is the whole of what an invitation
 * grants, which is why it shows the title, the date, and who sent it, and
 * nothing from inside the meeting.
 */
export function InvitationsPage() {
  const invitations = useInvitations();
  const respond = useRespondToInvitation();
  const rows = invitations.data ?? [];

  const answer = (id: number, accept: boolean, title: string) =>
    respond.mutate(
      { id, accept },
      {
        onSuccess: () =>
          toast.success(accept ? `${title} 공유를 승인했습니다.` : "초대를 거절했습니다."),
        onError: (err) => toast.error("처리 실패", { description: err.message }),
      },
    );

  return (
    <>
      <PageHeader
        title="공유 초대"
        meta={invitations.data ? <span>{rows.length}건</span> : null}
      />

      <div className="mx-auto w-full max-w-3xl px-5 py-4">
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-panel">
          {invitations.isPending ? (
            <SkeletonRows rows={3} className="p-4" />
          ) : invitations.isError ? (
            <div className="p-4">
              <ErrorState error={invitations.error} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title="받은 공유 초대가 없습니다."
              hint="다른 사용자가 회의를 공유하면 여기에 표시됩니다. 승인하기 전에는 회의를 열람할 수 없습니다."
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{r.meeting_title}</p>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      공유자 {r.shared_by} · 회의일{" "}
                      {r.held_at_known ? (
                        fmtDate(r.occurred_at)
                      ) : (
                        <span className="text-fg-subtle">{fmtDate(r.occurred_at)} 등록</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
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
                      승인
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
