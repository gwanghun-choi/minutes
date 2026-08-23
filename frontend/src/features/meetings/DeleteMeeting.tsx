import { toast } from "sonner";

import { useDeleteMeeting, useLeaveSharedMeeting } from "../../api/queries";
import type { MeetingStatus } from "../../api/types";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { MEETING_STATUS, SETTLED } from "../../lib/labels";

/**
 * 삭제, which is two different acts wearing one word.
 *
 * The owner's deletes the meeting: the recording, the minutes, the index, the
 * insights, and everybody else's access to all of it. A shared reader's removes
 * the one thing that is theirs — the accepted share that let them read it — and
 * the owner's screen does not move. The label is the same because the user's
 * intent is the same ("get this off my screen"); the dialog is where they part,
 * and it has to be unmistakable, because one of them is irreversible for
 * somebody else.
 *
 * One component for both, mounted once per screen, so the meeting list, the
 * sidebar tree and the detail page cannot end up with three versions of this
 * sentence. Which mutation runs is `is_owner`, which the server computed — and
 * the server refuses the other one either way.
 */
export interface Doomed {
  id: number;
  display_title: string;
  is_owner: boolean;
  /** Only the detail page knows these two; both only change the owner's copy. */
  status?: MeetingStatus;
  /** How many accounts have accepted a share. Null for a shared reader. */
  shared_with?: number | null;
}

export function DeleteMeetingDialog({
  meeting, onClose, onDeleted,
}: {
  meeting: Doomed | null;
  onClose: () => void;
  /** The detail page leaves for the list; a list just closes the dialog. */
  onDeleted?: () => void;
}) {
  const remove = useDeleteMeeting();
  const leave = useLeaveSharedMeeting();
  const owner = meeting?.is_owner ?? false;
  const action = owner ? remove : leave;
  // Unsettled means a background task may still be holding it — which after a
  // restart is nobody, so delete is offered at every status and says why.
  const processing = meeting?.status !== undefined && !SETTLED.includes(meeting.status);
  const sharedWith = meeting?.shared_with ?? 0;

  return (
    <ConfirmDialog
      open={meeting !== null}
      onOpenChange={(next) => !next && onClose()}
      title={owner ? "이 회의를 삭제할까요?" : "공유받은 회의를 삭제할까요?"}
      confirmLabel="삭제"
      destructive
      loading={action.isPending}
      onConfirm={() => {
        // The confirm button is already disabled in flight; this is the second
        // guard, so a double Enter cannot send two requests.
        if (!meeting || action.isPending) return;
        action.mutate(meeting.id, {
          onSuccess: () => {
            toast.success(owner ? "회의를 삭제했습니다." : "내 목록에서 삭제했습니다.");
            onClose();
            onDeleted?.();
          },
          onError: (err) => toast.error("삭제 실패", { description: err.message }),
        });
      }}
      body={
        owner ? (
          <>
            <strong className="text-fg">{meeting?.display_title}</strong> 의 회의록, 검색
            인덱스, 인사이트, 공유 내역, 업로드한 음성이 모두 삭제됩니다.
            <br />
            되돌릴 수 없습니다.
            {sharedWith > 0 ? (
              <>
                <br />
                <br />
                <strong className="text-danger">{sharedWith}명에게 공유 중입니다.</strong>{" "}
                삭제하면 공유받은 사용자도 이 회의를 더 이상 열람하거나 검색할 수 없습니다.
              </>
            ) : null}
            {processing && meeting?.status ? (
              <>
                <br />
                <br />
                아직 분석이 끝나지 않은 회의입니다. 현재 상태는 “
                {MEETING_STATUS[meeting.status]}”이며, 분석이 실제로 진행 중이라면 그 작업은
                아무것도 저장하지 못한 채 끝납니다.
              </>
            ) : null}
          </>
        ) : (
          <>
            <strong className="text-fg">{meeting?.display_title}</strong> 은(는) 내 회의
            목록에서만 삭제됩니다.
            <br />
            원본 회의와 다른 사용자의 공유에는 영향을 주지 않습니다.
            <br />
            삭제 후에는 이 회의에 더 이상 접근할 수 없습니다.
          </>
        )
      }
    />
  );
}
