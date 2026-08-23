import { RefreshCcwDot } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { useReindex } from "../../api/queries";
import type { MeetingDetail } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { DeleteMeetingDialog, type Doomed } from "./DeleteMeeting";
import { FilingDialog, MeetingRowMenu, type FilingAction } from "./FilingActions";

/**
 * Everything you can *do* to a meeting from its own page, in the header.
 *
 * One button and one menu:
 *
 *     [검색 인덱스 다시 생성] [⋯ → 이름 변경 / 카테고리 이동 / 삭제]
 *
 * 삭제 lives in the menu and nowhere else. It used to be a red button in a 관리
 * panel at the bottom of the 개요 tab, which put the most destructive action on
 * the page in the place a reader scrolls past — and gave it two homes once the
 * row menu grew one. A single surface is also what makes the shared reader's
 * version possible: the same menu, the same word, a different act, decided by
 * `role` rather than by which screen you are on.
 *
 * Re-embedding is the owner's and only for an approved meeting: there is
 * nothing to re-embed before there is an approved transcript, and the server
 * refuses the request from a shared reader either way. Drawing it for them
 * would offer a button that cannot work, on somebody else's recording.
 */
export function MeetingActions({ detail }: { detail: MeetingDetail }) {
  const meeting = detail.meeting;
  const owner = detail.role === "OWNER";
  const navigate = useNavigate();
  const reindex = useReindex(meeting.id);
  const [confirmReindex, setConfirmReindex] = useState(false);
  const [filing, setFiling] = useState<FilingAction | null>(null);
  const [doomed, setDoomed] = useState<Doomed | null>(null);

  return (
    <>
      {owner && meeting.status === "COMPLETED" ? (
        <Button
          size="sm"
          icon={<RefreshCcwDot className="size-4" />}
          loading={reindex.isPending}
          onClick={() => setConfirmReindex(true)}
        >
          검색 인덱스 다시 생성
        </Button>
      ) : null}

      {/* The same menu every list row carries, so 이름 변경, 카테고리 이동 and
          삭제 are one set of words wherever you meet the meeting. */}
      <MeetingRowMenu
        meeting={meeting}
        onAct={setFiling}
        onDelete={() =>
          setDoomed({
            id: meeting.id,
            display_title: meeting.display_title,
            is_owner: owner,
            status: meeting.status,
            shared_with: detail.shared_with,
          })
        }
      />

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

      <FilingDialog action={filing} onClose={() => setFiling(null)} />
      <DeleteMeetingDialog
        meeting={doomed}
        onClose={() => setDoomed(null)}
        // Whichever kind of 삭제 it was, this page is gone for this account.
        onDeleted={() => navigate("/", { replace: true })}
      />
    </>
  );
}
