import clsx from "clsx";
import { ChevronRight, FolderPlus, Inbox, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { useCategories, useCategoryMutations, useMeetings } from "../../api/queries";
import type { MeetingCategory } from "../../api/types";
import { NAV_ROW, NAV_ROW_ACTIVE, NAV_ROW_IDLE } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Menu, MenuItem } from "../../components/ui/Menu";
import { Field, Input, Select } from "../../components/ui/controls";
import { SkeletonRows } from "../../components/ui/feedback";

/**
 * The category tree, in the app's one sidebar — and the only place categories
 * are managed.
 *
 * There used to be a separate 카테고리 관리 page for creating and renaming, which
 * meant leaving the list to organise the list. Filing is an everyday act, so it
 * belongs where the folders are: `[+]` makes one, and each row's `⋯` renames,
 * moves, nests, or removes it. The page is gone.
 *
 * The tree is *personal* (migration 011). Nothing here is shared, so a folder
 * name is never seen by another account and two people may both have a 업무.
 *
 * Expanding a category shows the few most recent meetings in it, which is what
 * makes the sidebar navigation rather than a filter bar. A few, not all: a
 * sidebar that renders every meeting stops being navigable at exactly the point
 * a person needs it to be, so the rest are behind 전체 보기 — the same list, at
 * `?category=`, where paging and filtering already live.
 */
const RECENT = 5;

function children(rows: MeetingCategory[], parent: number | null): MeetingCategory[] {
  return rows.filter((r) => r.parent_id === parent);
}

/** The few most recent meetings in one category, once it is open. */
function CategoryMeetings({
  category, onNavigate, indent,
}: { category: number; onNavigate: () => void; indent: number }) {
  const page = useMeetings({ category, page_size: RECENT, sort: "held_desc" });
  const rows = page.data?.items ?? [];
  // The page's own total, not the tree's count: they are the same number, and
  // this one is the answer to the request that produced these rows.
  const total = page.data?.total ?? rows.length;
  const style = { paddingLeft: `${indent * 0.75 + 2.25}rem` };

  if (page.isPending) return <SkeletonRows rows={1} className="px-2 py-1" />;
  if (rows.length === 0) {
    return (
      <li className="py-1 text-[11px] text-fg-subtle" style={style}>
        아직 회의가 없습니다.
      </li>
    );
  }
  return (
    <>
      {rows.map((m) => (
        <li key={m.id}>
          <Link
            to={`/meetings/${m.id}`}
            onClick={onNavigate}
            title={m.display_title}
            className={clsx(NAV_ROW, NAV_ROW_IDLE, "text-[12px]")}
            style={style}
          >
            <span className="min-w-0 flex-1 truncate">{m.display_title}</span>
          </Link>
        </li>
      ))}
      {total > rows.length ? (
        <li>
          <Link
            to={{ pathname: "/", search: `?category=${category}` }}
            onClick={onNavigate}
            className={clsx(NAV_ROW, NAV_ROW_IDLE, "text-[12px] text-primary")}
            style={style}
          >
            전체 보기 ({total})
          </Link>
        </li>
      ) : null}
    </>
  );
}

function Row({
  row, rows, active, open, onToggle, onNavigate, onEdit, onDelete,
}: {
  row: MeetingCategory;
  rows: MeetingCategory[];
  active: string;
  open: Set<number>;
  onToggle: (id: number) => void;
  onNavigate: () => void;
  onEdit: (draft: Draft) => void;
  onDelete: (row: MeetingCategory) => void;
}) {
  const kids = children(rows, row.id);
  const expanded = open.has(row.id);
  const selected = active === String(row.id);

  return (
    <li>
      <div className="group relative flex items-center">
        <button
          type="button"
          aria-label={`${row.name} ${expanded ? "접기" : "펼치기"}`}
          aria-expanded={expanded}
          onClick={() => onToggle(row.id)}
          className="absolute left-0 rounded p-0.5 text-fg-subtle hover:text-fg"
          style={{ marginLeft: `${row.depth * 0.75}rem` }}
        >
          <ChevronRight
            aria-hidden
            className={clsx("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <Link
          to={{ pathname: "/", search: `?category=${row.id}` }}
          onClick={onNavigate}
          aria-current={selected ? "page" : undefined}
          title={row.path}
          className={clsx(NAV_ROW, "min-w-0 flex-1 pr-7", selected ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
          style={{ paddingLeft: `${row.depth * 0.75 + 1.25}rem` }}
        >
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          {row.meeting_count > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">
              {row.meeting_count}
            </span>
          ) : null}
        </Link>
        {/* One trigger, not a row of hover icons — the same rule the chat list
            follows. Everything a folder can have done to it is in here. */}
        <Menu
          label={`${row.name} 카테고리 메뉴`}
          className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MenuItem
            onSelect={() => onEdit({ mode: "rename", row })}
            icon={<Pencil aria-hidden className="size-3.5" />}
          >
            이름 변경
          </MenuItem>
          <MenuItem
            onSelect={() => onEdit({ mode: "create", parentId: row.id })}
            icon={<FolderPlus aria-hidden className="size-3.5" />}
          >
            하위 카테고리 추가
          </MenuItem>
          <MenuItem
            onSelect={() => onEdit({ mode: "move", row })}
            icon={<Layers aria-hidden className="size-3.5" />}
          >
            상위 카테고리 변경
          </MenuItem>
          <MenuItem
            destructive
            onSelect={() => onDelete(row)}
            icon={<Trash2 aria-hidden className="size-3.5" />}
          >
            삭제
          </MenuItem>
        </Menu>
      </div>
      {expanded ? (
        <ul>
          {kids.map((k) => (
            <Row
              key={k.id}
              row={k}
              rows={rows}
              active={active}
              open={open}
              onToggle={onToggle}
              onNavigate={onNavigate}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
          <CategoryMeetings category={row.id} indent={row.depth} onNavigate={onNavigate} />
        </ul>
      ) : null}
    </li>
  );
}

type Draft =
  | { mode: "create"; parentId: number | null }
  | { mode: "rename"; row: MeetingCategory }
  | { mode: "move"; row: MeetingCategory };

/**
 * Make, rename, or re-parent — one dialog, because they are one form with a
 * different field enabled. The server refuses a cycle and a duplicate name; this
 * only hides the two choices that are obviously wrong (itself, its own subtree).
 */
function CategoryDialog({
  draft, rows, onClose,
}: { draft: Draft; rows: MeetingCategory[]; onClose: () => void }) {
  const { create, rename, move } = useCategoryMutations();
  const existing = draft.mode === "create" ? null : draft.row;
  const [name, setName] = useState(existing?.name ?? "");
  const [parent, setParent] = useState<string>(
    draft.mode === "create"
      ? String(draft.parentId ?? "")
      : String(draft.row.parent_id ?? ""),
  );
  const pending = create.isPending || rename.isPending || move.isPending;

  /** Its own subtree cannot become its parent — the server refuses it too. */
  const descendants = (id: number): number[] =>
    children(rows, id).flatMap((k) => [k.id, ...descendants(k.id)]);
  const forbidden = existing ? new Set([existing.id, ...descendants(existing.id)]) : new Set();

  const submit = () => {
    const trimmed = name.trim();
    const parentId = parent ? Number(parent) : null;
    const done = (message: string) => () => {
      toast.success(message);
      onClose();
    };
    const fail = (err: Error) => toast.error("실패", { description: err.message });

    if (draft.mode === "create") {
      if (!trimmed) return;
      create.mutate({ name: trimmed, parent_id: parentId },
        { onSuccess: done("카테고리를 만들었습니다."), onError: fail });
    } else if (draft.mode === "rename") {
      if (!trimmed) return;
      rename.mutate({ id: draft.row.id, name: trimmed },
        { onSuccess: done("이름을 바꿨습니다."), onError: fail });
    } else {
      move.mutate({ id: draft.row.id, parent_id: parentId },
        { onSuccess: done("카테고리를 옮겼습니다."), onError: fail });
    }
  };

  const title =
    draft.mode === "create" ? "새 카테고리"
      : draft.mode === "rename" ? "카테고리 이름 변경"
        : "상위 카테고리 변경";

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={title}
      description="카테고리는 내 화면에서만 쓰이며 다른 사용자에게 보이지 않습니다."
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" variant="primary" loading={pending} onClick={submit}>
            {draft.mode === "create" ? "추가" : "저장"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {draft.mode === "move" ? null : (
          <Field label="이름">
            <Input
              autoFocus
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 고객사 A"
              className="w-full"
            />
          </Field>
        )}
        {draft.mode === "rename" ? null : (
          <Field label="상위 카테고리">
            <Select
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className="w-full"
            >
              <option value="">최상위</option>
              {rows
                .filter((k) => !forbidden.has(k.id))
                .map((k) => (
                  <option key={k.id} value={k.id}>{k.path}</option>
                ))}
            </Select>
          </Field>
        )}
      </form>
    </Dialog>
  );
}

export function CategoryNav({ onNavigate }: { onNavigate?: () => void }) {
  const categories = useCategories();
  const { remove } = useCategoryMutations();
  const [params] = useSearchParams();
  const active = params.get("category") ?? "";
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [doomed, setDoomed] = useState<MeetingCategory | null>(null);
  const rows = categories.data ?? [];
  const done = onNavigate ?? (() => undefined);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2.5 py-2">
      <div className="flex items-center gap-1 pb-1">
        <h2 className="flex-1 px-2 text-[11px] font-medium text-fg-subtle">카테고리</h2>
        <button
          type="button"
          aria-label="새 카테고리"
          onClick={() => setDraft({ mode: "create", parentId: null })}
          className="rounded p-1 text-fg-subtle hover:bg-surface-muted hover:text-fg"
        >
          <Plus aria-hidden className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul>
          <li>
            <Link
              to="/"
              onClick={done}
              aria-current={active === "" ? "page" : undefined}
              className={clsx(NAV_ROW, active === "" ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
            >
              <Layers aria-hidden className="size-4 shrink-0" />
              전체 회의
            </Link>
          </li>
          <li>
            <Link
              to={{ pathname: "/", search: "?category=none" }}
              onClick={done}
              aria-current={active === "none" ? "page" : undefined}
              className={clsx(NAV_ROW, active === "none" ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
            >
              <Inbox aria-hidden className="size-4 shrink-0" />
              미분류
            </Link>
          </li>
        </ul>

        {categories.isPending ? (
          <SkeletonRows rows={3} className="mt-1" />
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-fg-muted">
            아직 카테고리가 없습니다. [+]로 만들어 회의와 채팅을 정리하세요.
          </p>
        ) : (
          <ul className="mt-1">
            {children(rows, null).map((row) => (
              <Row
                key={row.id}
                row={row}
                rows={rows}
                active={active}
                open={open}
                onToggle={toggle}
                onNavigate={done}
                onEdit={setDraft}
                onDelete={setDoomed}
              />
            ))}
          </ul>
        )}
      </div>

      {draft ? (
        <CategoryDialog draft={draft} rows={rows} onClose={() => setDraft(null)} />
      ) : null}

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title="이 카테고리를 삭제할까요?"
        confirmLabel="삭제"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          const target = doomed;
          if (!target) return;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success("카테고리를 삭제했습니다.");
              setDoomed(null);
            },
            onError: (err) => toast.error("삭제 실패", { description: err.message }),
          });
        }}
        body={
          <>
            <strong className="text-fg">{doomed?.name}</strong> 폴더만 사라집니다. 안에 있던
            회의 {doomed?.meeting_count ?? 0}개와 채팅 {doomed?.chat_count ?? 0}개는 그대로 남고
            미분류가 됩니다.
          </>
        }
      />
    </div>
  );
}
