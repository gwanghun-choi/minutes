import { FilePen, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { useVersionMutations, useVersions } from "../../api/queries";
import type { MeetingDetail } from "../../api/types";
import { VersionStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { ErrorState, SkeletonRows } from "../../components/ui/feedback";
import { fmtDate } from "../../lib/format";

/**
 * Which revision of the minutes is live, and which one is being written.
 *
 * The sentence this panel has to get across is that starting a correction costs
 * the reader nothing: the published version keeps answering every question until
 * the new one has finished indexing. So the current version is stated first and
 * the draft is described in relation to it, not the other way round.
 *
 * A shared reader sees the history — "these minutes changed, when?" is a fair
 * question — and none of the buttons. The server refuses them too.
 */
export function VersionPanel({ detail }: { detail: MeetingDetail }) {
  const meetingId = detail.meeting.id;
  const owner = detail.role === "OWNER";
  const history = useVersions(meetingId);
  const { create, discard } = useVersionMutations(meetingId);
  const [params, setParams] = useSearchParams();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const rows = history.data?.versions ?? [];
  const active = history.data?.active_version ?? detail.active_version;
  const draft = detail.draft_version;

  /** Open a revision in the transcript tab. `?version=` is what the detail
   *  query reads, so the two panels always show the same one. */
  const open = (version: number) => {
    const next = new URLSearchParams(params);
    next.set("tab", "transcript");
    next.set("version", String(version));
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className="space-y-3">
        <p className="text-sm text-fg">
          현재 검색·열람에 쓰이는 버전은{" "}
          <strong className="text-fg">v{active ?? "-"}</strong> 입니다.
          {draft ? (
            <>
              {" "}
              <strong className="text-warning">v{draft}</strong> 를 수정하는 동안에도 채팅과
              검색은 계속 v{active} 를 사용하고, 승인이 끝나야 v{draft} 로 바뀝니다.
            </>
          ) : null}
        </p>

        {history.isPending ? (
          <SkeletonRows rows={2} />
        ) : history.isError ? (
          <ErrorState error={history.error} />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <span className="w-10 shrink-0 text-sm font-medium tabular-nums text-fg">
                  v{v.version}
                </span>
                <VersionStatusBadge status={v.status} />
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                  {v.status === "PUBLISHED" && v.published_at
                    ? `${fmtDate(v.published_at)} 승인`
                    : `${fmtDate(v.created_at)} 생성`}
                  {v.created_by ? ` · ${v.created_by}` : ""}
                  {` · 발화 ${v.segment_count}개`}
                </span>
                <Button size="sm" variant="ghost" onClick={() => open(v.version)}>
                  보기
                </Button>
              </li>
            ))}
          </ul>
        )}

        {owner ? (
          <div className="flex flex-wrap items-center gap-2">
            {draft ? (
              <>
                <Button size="sm" variant="primary" onClick={() => open(draft)}>
                  v{draft} 이어서 수정
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 aria-hidden className="size-4" />}
                  onClick={() => setConfirmDiscard(true)}
                >
                  수정 취소
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                icon={<FilePen aria-hidden className="size-4" />}
                loading={create.isPending}
                disabled={active === null}
                onClick={() =>
                  create.mutate(undefined, {
                    onSuccess: (r) => {
                      toast.success(`v${r.version} 수정본을 만들었습니다.`);
                      open(r.version);
                    },
                    onError: (err) => toast.error("실패", { description: err.message }),
                  })
                }
              >
                회의록 수정
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={`v${draft} 수정본을 삭제할까요?`}
        confirmLabel="수정본 삭제"
        destructive
        loading={discard.isPending}
        onConfirm={() => {
          if (draft === null || discard.isPending) return;
          discard.mutate(draft, {
            onSuccess: () => {
              toast.success("수정본을 삭제했습니다.");
              setConfirmDiscard(false);
              open(active ?? 1);
            },
            onError: (err) => toast.error("실패", { description: err.message }),
          });
        }}
        body={
          <>
            수정 중이던 내용이 사라집니다. 현재 버전 v{active} 와 검색 결과는 그대로
            유지됩니다.
          </>
        }
      />
    </>
  );
}
