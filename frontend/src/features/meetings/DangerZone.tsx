import { RefreshCcwDot, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { useDeleteMeeting, useReindex } from "../../api/queries";
import type { Meeting } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { Panel } from "../../components/ui/Panel";
import { MEETING_STATUS, SETTLED } from "../../lib/labels";

/**
 * Kept away from the page's primary actions on purpose.
 *
 * Delete is offered at every status, including the ones a background task
 * normally holds. Background tasks are in-process: a server restart leaves a
 * meeting sitting in 화자 분리 중 with nothing working on it, and hiding the
 * button there left it on the list with no way out. The server takes the same
 * view — one delete policy, no status gate — and the pipeline is what makes it
 * safe, checking the meeting still exists before it writes.
 *
 * Re-embedding is still approved-meetings-only: there is nothing to re-embed
 * before there is an approved transcript.
 */
export function DangerZone({
  meeting, sharedWith = 0,
}: {
  meeting: Meeting;
  /**
   * How many accounts have accepted a share. The owner keeps the right to delete
   * a meeting they shared — but they have to be told that it disappears for
   * everybody, not only from their own list.
   */
  sharedWith?: number;
}) {
  const navigate = useNavigate();
  const reindex = useReindex(meeting.id);
  const remove = useDeleteMeeting();
  const [confirmReindex, setConfirmReindex] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const processing = !SETTLED.includes(meeting.status);

  return (
    <Panel
      title="관리"
      description={
        processing
          ? `되돌리기 어려운 작업입니다. 현재 상태는 "${MEETING_STATUS[meeting.status]}"이며, 서버가 재시작된 뒤라면 분석이 더 이상 진행되지 않을 수 있습니다.`
          : "되돌리기 어려운 작업입니다."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {meeting.status === "COMPLETED" ? (
          <Button
            size="sm"
            icon={<RefreshCcwDot className="size-4" />}
            loading={reindex.isPending}
            onClick={() => setConfirmReindex(true)}
          >
            검색 인덱스 다시 생성
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 className="size-4" />}
          onClick={() => setConfirmDelete(true)}
        >
          회의 삭제
        </Button>
      </div>

      <ConfirmDialog
        open={confirmReindex}
        onOpenChange={setConfirmReindex}
        title="검색 인덱스를 다시 만들까요?"
        confirmLabel="다시 생성"
        loading={reindex.isPending}
        onConfirm={() =>
          reindex.mutate(undefined, {
            onSuccess: () => {
              setConfirmReindex(false);
              toast.success("검색 인덱스를 다시 만들고 있습니다.");
            },
            onError: (err) => toast.error("실패", { description: err.message }),
          })
        }
        body={
          <>
            승인된 회의록을 그대로 두고 검색용 조각과 벡터만 다시 만듭니다.
            <br />
            음성 인식과 화자 분리는 다시 실행하지 않습니다.
          </>
        }
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="이 회의를 삭제할까요?"
        confirmLabel="삭제"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          // The dialog's confirm button is already disabled while the request is
          // in flight; this is the second guard, so a double Enter cannot send
          // two deletes.
          if (remove.isPending) return;
          remove.mutate(meeting.id, {
            onSuccess: () => {
              toast.success("회의를 삭제했습니다.");
              navigate("/", { replace: true });
            },
            onError: (err) => toast.error("삭제 실패", { description: err.message }),
          });
        }}
        body={
          <>
            <strong className="text-fg">{meeting.display_title}</strong> 의 회의록,
            검색 인덱스, 인사이트, 공유 내역, 업로드한 음성이 모두 삭제됩니다.
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
            {processing ? (
              <>
                <br />
                <br />
                아직 분석이 끝나지 않은 회의입니다. 분석이 실제로 진행 중이라면 그 작업은
                아무것도 저장하지 못한 채 끝납니다.
              </>
            ) : null}
          </>
        }
      />
    </Panel>
  );
}
