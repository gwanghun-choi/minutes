import { FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "../../api/client";
import { useCreateSummary, useSummary } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Panel } from "../../components/ui/Panel";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/ui/feedback";

/**
 * Only an approved meeting has a summary: a draft one would carry the same
 * authority as the reviewed minutes while resting on unchecked text. Which is
 * why this is only mounted once the meeting is approved — before that the
 * overview shows `PendingNotice` instead, and `approved` still gates the query.
 */
export function SummaryPanel({ meetingId, approved }: { meetingId: number; approved: boolean }) {
  const summary = useSummary(meetingId, approved);
  const create = useCreateSummary(meetingId);

  const missing = summary.error instanceof ApiError && summary.error.status === 404;
  const generate = () =>
    create.mutate(undefined, {
      onSuccess: () => toast.success("요약을 생성했습니다."),
      onError: (err) => toast.error("요약 생성 실패", { description: err.message }),
    });

  return (
    <Panel
      title="회의 요약"
      description="회의록 전체를 한 번에 읽고 만든 사람이 읽는 요약입니다."
      actions={
        <Button
          size="sm"
          variant={summary.data ? "secondary" : "primary"}
          loading={create.isPending}
          icon={summary.data ? <RefreshCw className="size-4" /> : undefined}
          onClick={generate}
        >
          {summary.data ? "다시 생성" : "요약 생성"}
        </Button>
      }
    >
      {create.isPending ? (
        <SkeletonRows rows={4} />
      ) : summary.isPending ? (
        <SkeletonRows rows={3} />
      ) : summary.data ? (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
          {summary.data.content}
        </div>
      ) : missing ? (
        <EmptyState
          icon={<FileText className="size-6" />}
          title="아직 생성된 요약이 없습니다."
          hint="핵심 요약·주요 논의·결정 사항·Action Item 순서로 정리해 드립니다."
        />
      ) : (
        <ErrorState
          error={summary.error}
          action={
            <Button size="sm" onClick={() => void summary.refetch()}>
              다시 시도
            </Button>
          }
        />
      )}
    </Panel>
  );
}
