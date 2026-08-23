import clsx from "clsx";
import { CheckCircle2, Lock, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { useApprove, useCorrections, useSaveTranscript } from "../../api/queries";
import type { Correction, MeetingDetail } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Select, Textarea } from "../../components/ui/controls";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorState } from "../../components/ui/feedback";
import { fmtTime } from "../../lib/format";
import { MEETING_STATUS } from "../../lib/labels";
import { speakerColors, speakerName } from "../../lib/speakers";
import { CorrectionPanel } from "./CorrectionPanel";

interface Draft {
  text: string;
  speakerId: number | null;
}

/**
 * The reviewer's working copy. Nothing here is on the server until 저장.
 *
 * Seeded once: polling stops at REVIEW_REQUIRED, so the only thing that changes
 * the stored segments underneath is this reviewer's own save — after which the
 * draft already holds exactly what was written. A refetch must never overwrite
 * an applied AI suggestion that has not been saved yet.
 */
function useDraft(detail: MeetingDetail) {
  const byCode = useMemo(
    () => new Map(detail.speakers.map((s) => [s.speaker_code, s.id])),
    [detail.speakers],
  );
  const initial = useMemo(
    () =>
      new Map<number, Draft>(
        detail.segments.map((s) => [
          s.sequence,
          { text: s.text, speakerId: (s.speaker_code && byCode.get(s.speaker_code)) || null },
        ]),
      ),
    [detail.segments, byCode],
  );
  const [draft, setDraft] = useState(initial);

  const set = (sequence: number, patch: Partial<Draft>) =>
    setDraft((prev) => {
      const next = new Map(prev);
      const current = prev.get(sequence);
      if (current) next.set(sequence, { ...current, ...patch });
      return next;
    });

  return { draft, set };
}

export function TranscriptPanel({
  detail, editable,
}: {
  detail: MeetingDetail;
  /**
   * Whether the revision on screen is the one open for editing, and this account
   * owns it. Decided by the page from the server's own answer — `role` and
   * `draft_version` — never inferred from the meeting status, which says nothing
   * about a revision of an already-approved meeting.
   */
  editable: boolean;
}) {
  const meeting = detail.meeting;
  const revising = detail.version > 1;
  const { draft, set } = useDraft(detail);
  const colors = speakerColors(detail.speakers);
  /* `?at=` is a reading position in seconds, written by a 출처 card in the chat.
     The segment ids a source cites are its provenance and stay in the payload;
     what a reader needs here is where to look, and the transcript is laid out by
     time. The first segment that has not ended yet is that place. */
  const at = useSearchParams()[0].get("at");
  const anchored = at === null
    ? null
    : detail.segments.find((s) => s.end_time >= Number(at))?.sequence ?? null;
  const anchorRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (anchored !== null) anchorRef.current?.scrollIntoView({ block: "center" });
  }, [anchored]);

  const save = useSaveTranscript(meeting.id);
  const approve = useApprove(meeting.id);
  const corrections = useCorrections(meeting.id);
  const [suggestions, setSuggestions] = useState<Correction[] | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [confirmApprove, setConfirmApprove] = useState(false);

  const payload = () =>
    [...draft.entries()].map(([sequence, d]) => ({
      sequence,
      text: d.text,
      speaker_id: d.speakerId,
    }));

  const runSave = () =>
    save.mutateAsync(payload()).then((r) => {
      toast.success(`${r.updated}개 발화를 저장했습니다.`);
      return r;
    });

  // Always save before approving, so an unsaved edit can never be silently lost.
  const runApprove = async () => {
    try {
      await save.mutateAsync(payload());
      await approve.mutateAsync();
      setConfirmApprove(false);
      toast.success("승인했습니다.", { description: "검색 인덱싱을 시작합니다." });
    } catch (err) {
      toast.error("승인 실패", { description: (err as Error).message });
    }
  };

  const applyOne = (c: Correction) => {
    set(c.sequence, { text: c.after });
    setApplied((prev) => new Set(prev).add(c.sequence));
  };

  if (detail.segments.length === 0) {
    return (
      <EmptyState
        title={
          meeting.status === "FAILED"
            ? "회의록을 만들지 못했습니다."
            : `분석 중입니다 (${MEETING_STATUS[meeting.status]})`
        }
        hint={meeting.error_message ?? "음성 인식과 화자 분리가 끝나면 여기에 표시됩니다."}
      />
    );
  }

  return (
    <div className="space-y-4">
      {editable ? (
        <div className="rounded-md border border-warning/30 bg-warning-soft px-4 py-3">
          <p className="text-sm font-medium text-warning">
            {revising ? `v${detail.version} 수정 중입니다.` : "검토가 필요합니다."}
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            {revising
              ? `승인하기 전까지 채팅과 검색은 계속 현재 버전 v${detail.active_version}을 사용합니다. 승인하면 v${detail.version}이 현재 버전이 됩니다.`
              : "AI가 만든 초안입니다. 승인해야 검색 대상이 되고, 승인 후에는 새 버전으로만 고칠 수 있습니다."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={<Sparkles className="size-4" />}
              loading={corrections.isPending}
              onClick={() =>
                corrections.mutate(undefined, {
                  onSuccess: (r) => {
                    setSuggestions(r.suggestions);
                    setApplied(new Set());
                  },
                  onError: (err) => toast.error("AI 후보정 실패", { description: err.message }),
                })
              }
            >
              AI 후보정
            </Button>
            <Button
              size="sm"
              loading={save.isPending}
              onClick={() =>
                void runSave().catch((err: Error) =>
                  toast.error("저장 실패", { description: err.message }),
                )
              }
            >
              수정 내용 저장
            </Button>
            <Button
              size="sm"
              variant="success"
              icon={<CheckCircle2 className="size-4" />}
              onClick={() => setConfirmApprove(true)}
            >
              승인하고 인덱싱
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface-muted px-4 py-2.5">
          <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
          <p className="text-xs text-fg-muted">
            {detail.role !== "OWNER"
              ? "공유받은 회의입니다. 읽기와 검색만 가능하며, 회의록은 소유자만 수정할 수 있습니다."
              : detail.version === detail.active_version
                ? "현재 버전은 읽기 전용입니다. 검색 근거와 발췌문이 이 문장을 그대로 인용하기 때문에, 고치려면 [회의록 수정]으로 새 버전을 만들어야 합니다."
                : `v${detail.version}은 이전 버전입니다. 기록으로 남아 있으며 수정할 수 없습니다.`}
          </p>
        </div>
      )}

      {suggestions ? (
        <div className="rounded-md border border-border bg-surface p-3.5">
          <CorrectionPanel
            suggestions={suggestions}
            applied={applied}
            onApply={applyOne}
            onApplyAll={() => suggestions.forEach(applyOne)}
            onDismiss={() => setSuggestions(null)}
          />
        </div>
      ) : null}

      {save.isError ? <ErrorState error={save.error} /> : null}

      <div className="overflow-hidden rounded-md border border-border bg-surface">
        <ul>
          {detail.segments.map((s) => {
            const d = draft.get(s.sequence);
            const color = (s.speaker_code && colors.get(s.speaker_code)) || "transparent";
            return (
              <li
                key={s.sequence}
                ref={s.sequence === anchored ? anchorRef : undefined}
                className={clsx(
                  "grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5 last:border-0 sm:grid-cols-[7rem_9rem_1fr]",
                  s.sequence === anchored && "bg-primary-soft",
                )}
                style={{ borderLeft: `3px solid ${color}` }}
              >
                <span className="text-xs tabular-nums text-fg-subtle">
                  {fmtTime(s.start_time)} ~ {fmtTime(s.end_time)}
                </span>
                {editable ? (
                  <Select
                    aria-label={`발화 ${s.sequence} 화자`}
                    className="h-7 w-full py-0 text-xs"
                    value={d?.speakerId ?? ""}
                    onChange={(e) => set(s.sequence, { speakerId: Number(e.target.value) || null })}
                  >
                    {detail.speakers.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {speakerName(sp)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-xs font-semibold" style={{ color }}>
                    {speakerName(s)}
                  </span>
                )}
                {editable ? (
                  <Textarea
                    aria-label={`발화 ${s.sequence} 내용`}
                    rows={1}
                    className="col-span-2 min-h-8 w-full py-1 sm:col-span-1"
                    value={d?.text ?? ""}
                    onChange={(e) => set(s.sequence, { text: e.target.value })}
                  />
                ) : (
                  <span className="col-span-2 text-sm text-fg sm:col-span-1">{s.text}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title={revising ? `v${detail.version}을 현재 버전으로 할까요?` : "회의록을 승인할까요?"}
        confirmLabel="저장하고 승인"
        loading={save.isPending || approve.isPending}
        onConfirm={() => void runApprove()}
        body={
          revising ? (
            <>
              수정한 내용을 저장하고 v{detail.version}의 검색 인덱스를 새로 만듭니다. 인덱싱이
              끝나야 현재 버전이 v{detail.version}로 바뀝니다.
              <br />
              그때까지, 그리고 인덱싱이 실패하면 계속 v{detail.active_version}이 검색에
              사용됩니다.
            </>
          ) : (
            <>
              승인하면 회의록이 확정되어{" "}
              <strong className="text-fg">이후에는 새 버전으로만 수정할 수 있습니다.</strong>
              <br />
              수정한 내용을 먼저 저장한 뒤 검색 인덱싱과 인사이트 추출을 시작합니다.
            </>
          )
        }
      />
    </div>
  );
}
