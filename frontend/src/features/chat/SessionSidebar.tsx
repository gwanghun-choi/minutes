import clsx from "clsx";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { ChatSession } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { SkeletonRows } from "../../components/ui/feedback";
import { ageBucket } from "../../lib/format";

/** The server owns the list; this only chooses which one is open. */
export function SessionSidebar({
  sessions, activeId, loading, creating, onNew, onOpen, onDelete, deleting,
}: {
  sessions: ChatSession[];
  activeId: number | null;
  loading: boolean;
  creating: boolean;
  onNew: () => void;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
  deleting: boolean;
}) {
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);

  const groups: { name: string; rows: ChatSession[] }[] = [];
  for (const row of sessions) {
    const name = ageBucket(row.updated_at);
    const last = groups.at(-1);
    if (last?.name === name) last.rows.push(row);
    else groups.push({ name, rows: [row] });
  }

  return (
    <aside className="flex w-full shrink-0 flex-col gap-2 border-b border-border bg-surface p-3 lg:h-dvh lg:w-64 lg:border-r lg:border-b-0">
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        loading={creating}
        onClick={onNew}
        icon={<MessageSquarePlus className="size-4" />}
      >
        새 채팅
      </Button>

      <div className="max-h-56 min-h-0 flex-1 overflow-y-auto lg:max-h-none">
        {loading ? (
          <SkeletonRows rows={4} />
        ) : sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-fg-muted">아직 대화가 없습니다.</p>
        ) : (
          groups.map((g) => (
            <div key={g.name} className="mb-2">
              <h2 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-fg-subtle">
                {g.name}
              </h2>
              <ul>
                {g.rows.map((r) => (
                  <li key={r.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpen(r.id)}
                      aria-current={r.id === activeId ? "page" : undefined}
                      className={clsx(
                        "min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px]",
                        r.id === activeId
                          ? "bg-primary-soft font-medium text-primary"
                          : "text-fg-muted hover:bg-surface-muted hover:text-fg",
                      )}
                    >
                      {r.title}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${r.title} 대화 삭제`}
                      className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => setPendingDelete(r)}
                      icon={<Trash2 className="size-3.5" />}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="이 대화를 삭제할까요?"
        confirmLabel="삭제"
        destructive
        loading={deleting}
        onConfirm={() => {
          if (!pendingDelete) return;
          onDelete(pendingDelete.id);
          setPendingDelete(null);
          toast.success("대화를 삭제했습니다.");
        }}
        body={
          <>
            <strong className="text-fg">{pendingDelete?.title}</strong> 의 질문과 답변이 모두
            사라집니다. 되돌릴 수 없습니다.
          </>
        }
      />
    </aside>
  );
}
