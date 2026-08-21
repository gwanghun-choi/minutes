import { Sparkles } from "lucide-react";

import type { Correction } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/feedback";

/**
 * AI 후보정 is a suggestion, never an edit.
 *
 * Three separate steps, and the UI has to keep them apart: the model proposes,
 * the reviewer applies it into the draft, and only 저장 writes anything. Nothing
 * here touches the server.
 */
export function CorrectionPanel({
  suggestions, applied, onApply, onApplyAll, onDismiss,
}: {
  suggestions: Correction[];
  applied: Set<number>;
  onApply: (c: Correction) => void;
  onApplyAll: () => void;
  onDismiss: () => void;
}) {
  if (suggestions.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles className="size-6" />}
        title="고칠 부분을 찾지 못했습니다."
        action={
          <Button size="sm" onClick={onDismiss}>
            닫기
          </Button>
        }
      />
    );
  }

  const remaining = suggestions.filter((s) => !applied.has(s.sequence)).length;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-xs text-fg-muted">
          제안 {suggestions.length}건. 반영해도 아직 저장된 것은 아닙니다 — 아래
          <span className="font-medium text-fg"> 수정 내용 저장</span>을 눌러야 기록됩니다.
        </p>
        <Button size="sm" onClick={onApplyAll} disabled={remaining === 0}>
          모두 반영{remaining ? ` (${remaining})` : ""}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          닫기
        </Button>
      </div>

      <ul className="space-y-2">
        {suggestions.map((s) => {
          const done = applied.has(s.sequence);
          return (
            <li
              key={s.sequence}
              className="flex flex-wrap items-start gap-3 rounded-md border border-border bg-surface-muted px-3 py-2.5"
            >
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <p className="text-fg-muted line-through decoration-danger/50">{s.before}</p>
                <p className="font-medium text-fg">{s.after}</p>
              </div>
              <Button
                size="sm"
                variant={done ? "ghost" : "primary"}
                disabled={done}
                onClick={() => onApply(s)}
              >
                {done ? "반영됨" : "반영"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
