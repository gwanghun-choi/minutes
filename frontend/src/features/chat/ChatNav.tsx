import clsx from "clsx";
import { Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { useChatSessions, useCreateChatSession, useDeleteChatSession } from "../../api/queries";
import type { ChatSession } from "../../api/types";
import { NAV_ROW, NAV_ROW_ACTIVE, NAV_ROW_IDLE } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { SkeletonRows } from "../../components/ui/feedback";
import { ageBucket } from "../../lib/format";

/**
 * Saved conversations, as part of the app's navigation.
 *
 * Self-contained on purpose: the server owns the list, so this reads it
 * directly instead of being handed it by the chat page. That is what lets it
 * live in the shell's sidebar rather than in a second panel beside it.
 */
export function ChatNav({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const routeId = useParams().sessionId;
  const activeId = routeId ? Number(routeId) : null;

  const sessions = useChatSessions();
  const create = useCreateChatSession();
  const remove = useDeleteChatSession();

  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);

  const open = (id: number) => {
    navigate(`/chat/${id}`);
    onNavigate?.();
  };

  // Consecutive runs, not a bucket map: the server already returns the list
  // newest first, so a group is just where the label changes.
  const groups = useMemo(() => {
    const text = query.trim().toLowerCase();
    const rows = (sessions.data ?? []).filter(
      (r) => !text || r.title.toLowerCase().includes(text),
    );
    const out: { name: string; rows: ChatSession[] }[] = [];
    for (const row of rows) {
      const name = ageBucket(row.updated_at);
      const last = out.at(-1);
      if (last?.name === name) last.rows.push(row);
      else out.push({ name, rows: [row] });
    }
    return out;
  }, [sessions.data, query]);

  const empty = (sessions.data ?? []).length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 py-2.5">
      <Button
        variant="secondary"
        size="sm"
        className="justify-start"
        loading={create.isPending}
        onClick={() => create.mutate([], { onSuccess: (s) => open(s.id) })}
        icon={<Plus aria-hidden className="size-4" />}
      >
        새 채팅
      </Button>

      {empty ? null : (
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="채팅 검색"
            aria-label="채팅 검색"
            className="w-full rounded border border-transparent bg-surface-muted py-1.5 pr-2 pl-7 text-[13px] text-fg placeholder:text-fg-subtle focus-visible:border-border"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.isPending ? (
          <SkeletonRows rows={4} />
        ) : empty ? (
          <p className="px-2 py-3 text-xs text-fg-muted">아직 대화가 없습니다.</p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-fg-muted">검색 결과가 없습니다.</p>
        ) : (
          groups.map((g) => (
            <div key={g.name} className="mb-1.5">
              <h2 className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-fg-subtle">
                {g.name}
              </h2>
              <ul>
                {g.rows.map((r) => (
                  <li key={r.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => open(r.id)}
                      aria-current={r.id === activeId ? "page" : undefined}
                      className={clsx(
                        NAV_ROW,
                        "w-full pr-7 text-left",
                        r.id === activeId ? NAV_ROW_ACTIVE : NAV_ROW_IDLE,
                      )}
                    >
                      <span className="min-w-0 truncate">{r.title}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${r.title} 대화 삭제`}
                      className="absolute top-1/2 right-0 size-6 -translate-y-1/2 px-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => setPendingDelete(r)}
                      icon={<Trash2 aria-hidden className="size-3.5" />}
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
        onOpenChange={(next) => !next && setPendingDelete(null)}
        title="이 대화를 삭제할까요?"
        confirmLabel="삭제"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          setPendingDelete(null);
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success("대화를 삭제했습니다.");
              // The open conversation just stopped existing; /chat picks the
              // next one, or starts a fresh one if there is none.
              if (target.id === activeId) navigate("/chat", { replace: true });
            },
            onError: (err) => toast.error("삭제 실패", { description: err.message }),
          });
        }}
        body={
          <>
            <strong className="text-fg">{pendingDelete?.title}</strong> 의 질문과 답변이 모두
            사라집니다. 되돌릴 수 없습니다.
          </>
        }
      />
    </div>
  );
}
