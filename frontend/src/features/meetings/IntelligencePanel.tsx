import { Lightbulb, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useIntelligence, useRebuildIntelligence } from "../../api/queries";
import type { FactType } from "../../api/types";
import { Badge, IntelStateBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Panel } from "../../components/ui/Panel";
import { EmptyState, ErrorState, SkeletonRows } from "../../components/ui/feedback";
import { FACT_TYPE } from "../../lib/labels";
import { FactCard } from "./FactCard";

const TYPES: FactType[] = ["REQUEST", "DECISION", "ACTION_ITEM"];

/**
 * Facts come out of the approved transcript, so this is COMPLETED-only — the
 * same rule the summary follows, for the same reason.
 */
export function IntelligencePanel({
  meetingId, approved,
}: { meetingId: number; approved: boolean }) {
  const intel = useIntelligence(meetingId, approved);
  const rebuild = useRebuildIntelligence(meetingId);
  const [filter, setFilter] = useState<FactType | "">("");

  if (!approved) {
    return (
      <Panel title="회의 인사이트">
        <p className="text-xs text-fg-muted">승인된 회의록에서만 정보를 추출할 수 있습니다.</p>
      </Panel>
    );
  }

  const facts = intel.data?.facts ?? [];
  const count = (t: FactType) => facts.filter((f) => f.fact_type === t).length;
  const shown = filter ? facts.filter((f) => f.fact_type === filter) : facts;
  const building = intel.data?.state === "BUILDING" || rebuild.isPending;

  return (
    <Panel
      title="회의 인사이트"
      description="회의록에서 요청·결정·할 일을 원문 근거와 함께 뽑아 둔 것입니다. 요약과는 별개로 만들어집니다."
      bodyClassName=""
      actions={
        <>
          {intel.data ? <IntelStateBadge state={intel.data.state} /> : null}
          <Button
            size="sm"
            icon={<RefreshCw className="size-4" />}
            loading={building}
            onClick={() =>
              rebuild.mutate(undefined, {
                onSuccess: () => toast.success("인사이트를 다시 만들고 있습니다."),
                onError: (err) => toast.error("생성 실패", { description: err.message }),
              })
            }
          >
            다시 생성
          </Button>
        </>
      }
    >
      {intel.isPending ? (
        <SkeletonRows rows={3} className="p-4" />
      ) : intel.isError ? (
        <div className="p-4">
          <ErrorState error={intel.error} />
        </div>
      ) : (
        <>
          {intel.data?.error ? (
            <div className="p-4 pb-0">
              <ErrorState error={new Error(intel.data.error)} />
            </div>
          ) : null}

          {facts.length > 0 ? (
            <div
              role="group"
              aria-label="종류로 거르기"
              className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5"
            >
              <Button
                size="sm"
                variant={filter === "" ? "primary" : "ghost"}
                aria-pressed={filter === ""}
                onClick={() => setFilter("")}
              >
                전체 {facts.length}
              </Button>
              {TYPES.map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={filter === t ? "primary" : "ghost"}
                  aria-pressed={filter === t}
                  onClick={() => setFilter(filter === t ? "" : t)}
                >
                  {FACT_TYPE[t]} {count(t)}
                </Button>
              ))}
            </div>
          ) : null}

          {building && facts.length === 0 ? (
            <SkeletonRows rows={3} className="p-4" />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={<Lightbulb className="size-6" />}
              title={
                facts.length
                  ? `${FACT_TYPE[filter as FactType]}에 해당하는 항목이 없습니다.`
                  : intel.data?.state === "NOT_BUILT"
                    ? "아직 인사이트를 만들지 않았습니다."
                    : "추출된 정보가 없습니다."
              }
              hint={
                facts.length
                  ? undefined
                  : "요청·결정·할 일은 회의에서 실제로 말한 발화가 있을 때만 만들어집니다."
              }
            />
          ) : (
            <ul aria-label="추출된 정보">
              {shown.map((f) => (
                <FactCard key={f.id} fact={f} />
              ))}
            </ul>
          )}

          {facts.some((f) => f.status === "UNKNOWN") ? (
            <p className="border-t border-border px-4 py-2.5 text-xs text-fg-subtle">
              <Badge>상태 미확인</Badge> 은 회의에서 완료 여부가 언급되지 않았다는 뜻입니다.
              끝나지 않았다는 의미가 아닙니다.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
