import clsx from "clsx";
import { Check, FolderInput, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import {
  useCategories, useChatSessions, useCreateChatSession, useDeleteChatSession,
  useRenameChatSession, useSetChatCategory,
} from "../../api/queries";
import type { ChatSession, MeetingCategory } from "../../api/types";
import { NAV_ROW, NAV_ROW_ACTIVE, NAV_ROW_IDLE } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Menu, MenuItem } from "../../components/ui/Menu";
import { Field, Select } from "../../components/ui/controls";
import { SkeletonRows } from "../../components/ui/feedback";

/** Same cap the server enforces, so the field cannot promise what it will trim. */
const TITLE_MAX = 40;

/**
 * Renaming, in the row being renamed.
 *
 * Inline rather than a dialog: the thing being edited is a one-line label that is
 * already on screen, and a modal would hide the list it belongs to. Enter saves,
 * Escape cancels, and an empty name cannot be saved — the server refuses it too.
 */
function RenameRow({
  session, onDone,
}: { session: ChatSession; onDone: () => void }) {
  const rename = useRenameChatSession();
  const [value, setValue] = useState(session.title);
  const name = value.trim();

  const save = () => {
    if (!name || name === session.title) return onDone();
    rename.mutate(
      { id: session.id, title: name },
      {
        onSuccess: () => {
          toast.success("대화 이름을 바꿨습니다.");
          onDone();
        },
        onError: (err) => toast.error("이름 변경 실패", { description: err.message }),
      },
    );
  };

  return (
    <form
      className="flex items-center gap-1 px-2 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        autoFocus
        value={value}
        maxLength={TITLE_MAX}
        aria-label="대화 이름"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-1 text-[13px] text-fg"
      />
      <button
        type="submit"
        aria-label="이름 저장"
        disabled={!name || rename.isPending}
        className="rounded p-1 text-fg-muted hover:bg-surface-muted hover:text-fg disabled:opacity-40"
      >
        <Check aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="이름 변경 취소"
        onClick={onDone}
        className="rounded p-1 text-fg-muted hover:bg-surface-muted hover:text-fg"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </form>
  );
}

/** Moving one conversation into a category, or out of one. */
function MoveDialog({
  session, categories, onClose,
}: { session: ChatSession; categories: MeetingCategory[]; onClose: () => void }) {
  const move = useSetChatCategory();
  const [value, setValue] = useState(String(session.category_id ?? ""));

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="카테고리 이동"
      description="회의와 같은 내 카테고리를 씁니다. 다른 사용자에게는 보이지 않습니다."
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>취소</Button>
          <Button
            size="sm"
            variant="primary"
            loading={move.isPending}
            onClick={() =>
              move.mutate(
                { id: session.id, category_id: value ? Number(value) : null },
                {
                  onSuccess: () => {
                    toast.success("대화를 옮겼습니다.");
                    onClose();
                  },
                  onError: (err) => toast.error("실패", { description: err.message }),
                },
              )
            }
          >
            이동
          </Button>
        </>
      }
    >
      <Field label="카테고리">
        <Select value={value} onChange={(e) => setValue(e.target.value)} className="w-full">
          <option value="">미분류</option>
          {categories.map((k) => (
            <option key={k.id} value={k.id}>{k.path}</option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}

/**
 * Saved conversations, as part of the app's navigation.
 *
 * Grouped by the same personal category tree the meeting sidebar uses, because a
 * person arranging their work does not keep two vocabularies for it. They were
 * grouped by *when* they were last used before that, which sorted the list
 * without helping anybody find anything in it.
 *
 * A conversation is still a conversation and a meeting is still a meeting —
 * nothing here makes them one kind of row in one table. Only the folders are
 * shared, and only in the sidebar.
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
  const categories = useCategories();
  const create = useCreateChatSession();
  const remove = useDeleteChatSession();

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [moving, setMoving] = useState<ChatSession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);

  const open = (id: number) => {
    navigate(`/chat/${id}`);
    onNavigate?.();
  };

  // One group per category the reader actually used, in the tree's own path
  // order, with 미분류 last. The server returns the list newest first, so each
  // group keeps that order without a second sort.
  const groups = useMemo(() => {
    const text = query.trim().toLowerCase();
    const rows = (sessions.data ?? []).filter(
      (r) => !text || r.title.toLowerCase().includes(text),
    );
    const paths = new Map((categories.data?.categories ?? []).map((k) => [k.id, k.path]));
    const order: (number | null)[] = [...paths.keys(), null];
    const byCategory = new Map<number | null, ChatSession[]>();
    for (const row of rows) {
      const key = row.category_id !== null && paths.has(row.category_id) ? row.category_id : null;
      byCategory.set(key, [...(byCategory.get(key) ?? []), row]);
    }
    return order
      .filter((key) => byCategory.has(key))
      .map((key) => ({
        name: key === null ? "미분류" : paths.get(key)!,
        rows: byCategory.get(key)!,
      }));
  }, [sessions.data, categories.data, query]);

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
                {g.rows.map((r) =>
                  editing === r.id ? (
                    <li key={r.id}>
                      <RenameRow session={r} onDone={() => setEditing(null)} />
                    </li>
                  ) : (
                    <li key={r.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => open(r.id)}
                        aria-current={r.id === activeId ? "page" : undefined}
                        className={clsx(
                          NAV_ROW,
                          "w-full pr-8 text-left",
                          r.id === activeId ? NAV_ROW_ACTIVE : NAV_ROW_IDLE,
                        )}
                      >
                        <span className="min-w-0 truncate">{r.title}</span>
                      </button>
                      {/* Row actions live behind one trigger so the row stays a
                          row: two icon buttons on hover is a toolbar. */}
                      <Menu
                        label={`${r.title} 대화 메뉴`}
                        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MenuItem
                          onSelect={() => setEditing(r.id)}
                          icon={<Pencil aria-hidden className="size-3.5" />}
                        >
                          이름 변경
                        </MenuItem>
                        <MenuItem
                          onSelect={() => setMoving(r)}
                          icon={<FolderInput aria-hidden className="size-3.5" />}
                        >
                          카테고리 이동
                        </MenuItem>
                        <MenuItem
                          destructive
                          onSelect={() => setPendingDelete(r)}
                          icon={<Trash2 aria-hidden className="size-3.5" />}
                        >
                          삭제
                        </MenuItem>
                      </Menu>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))
        )}
      </div>

      {moving ? (
        <MoveDialog
          session={moving}
          categories={categories.data?.categories ?? []}
          onClose={() => setMoving(null)}
        />
      ) : null}

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
