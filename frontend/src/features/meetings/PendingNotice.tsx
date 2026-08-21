import type { ReactNode } from "react";

import type { MeetingStatus } from "../../api/types";
import { MeetingStatusBadge } from "../../components/ui/Badge";

/**
 * Why a panel is empty, and what to do about it.
 *
 * A summary and a set of facts both come from an approved transcript, so before
 * approval both are empty for exactly one reason. Showing skeleton rows there was
 * a lie — nothing was loading, and nothing would start on its own. This says
 * which state the meeting is in, why that state has no content, and what the next
 * action is, in one place so the two panels cannot word it differently.
 *
 * It never invents content. There is no draft summary and no provisional fact.
 */
const STAGE: Record<MeetingStatus, { why: string; steps?: string[] }> = {
  UPLOADED: { why: "음성 분석이 아직 시작되지 않았습니다." },
  TRANSCRIBING: { why: "음성을 텍스트로 바꾸고 있습니다. 끝나면 회의록을 검토할 수 있습니다." },
  DIARIZING: { why: "화자를 분리하고 있습니다. 끝나면 회의록을 검토할 수 있습니다." },
  REVIEW_REQUIRED: {
    why: "AI가 만든 회의록 초안이 아직 승인되지 않았습니다. 승인해야 검색과 생성의 근거가 됩니다.",
    steps: ["회의록 탭에서 초안 검토", "수정 내용 저장", "승인하고 인덱싱"],
  },
  INDEXING: { why: "승인된 회의록으로 검색 인덱스를 만들고 있습니다. 잠시 후 다시 확인해 주세요." },
  COMPLETED: { why: "승인된 회의록이 준비되어 있습니다." },
  FAILED: { why: "음성 분석이 실패해 회의록이 없습니다. 위의 오류 메시지를 확인해 주세요." },
};

export function PendingNotice({
  status, title, action,
}: { status: MeetingStatus; title: string; action?: ReactNode }) {
  const stage = STAGE[status];
  return (
    <div className="flex flex-col items-start gap-2.5 px-4 py-6">
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-muted">현재 상태</span>
        <MeetingStatusBadge status={status} />
      </div>
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="max-w-prose text-xs leading-relaxed text-fg-muted">{stage.why}</p>

      {stage.steps ? (
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-muted">
          {stage.steps.map((step, i) => (
            <li key={step} className="flex items-center gap-1.5">
              {i > 0 ? <span className="text-fg-subtle">→</span> : null}
              <span className="flex size-4 items-center justify-center rounded-full bg-surface-muted text-[10px] font-medium text-fg-muted">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      ) : null}

      {action}
    </div>
  );
}
