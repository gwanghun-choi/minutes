import clsx from "clsx";
import { ChevronRight, FolderPlus, Inbox, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useMatch, useSearchParams } from "react-router";
import { toast } from "sonner";

import {
  useCategories, useCategoryMutations, useMeeting, useMeetings,
} from "../../api/queries";
import type { MeetingCategory, MeetingListRow } from "../../api/types";
import {
  NAV_ROW, NAV_ROW_ACTIVE, NAV_ROW_IDLE, NAV_ROW_SELECTED,
} from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { Menu, MenuItem } from "../../components/ui/Menu";
import { Field, Input, Select } from "../../components/ui/controls";
import { SkeletonRows } from "../../components/ui/feedback";
import { COUNT_MAX, countLabel } from "../../lib/format";
import { DeleteMeetingDialog } from "./DeleteMeeting";
import { FilingDialog, MeetingRowMenu, type FilingAction } from "./FilingActions";

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

/**
 * What can be unfolded. 미분류 is a folder in every way that matters to a reader
 * — it holds meetings and they have to be reachable — but it is the *absence*
 * of a filing row rather than one of the account's categories, so it has no id.
 */
type Folder = number | "none";

/**
 * The number beside a navigation row.
 *
 * One component so 전체 회의, 미분류, and every folder share one typography, one
 * column, and one rule. Zero is not drawn: the tree has hidden an empty folder's
 * count since it had counts at all, and a second rule for the two fixed rows
 * would read as a bug rather than a policy.
 *
 * Past 99 the label is `99+` — the exact figure stops being readable at a glance
 * long before a narrow sidebar stops having room for it — and only then does the
 * row carry a title with the real number, so the one case where the screen hides
 * it is the one case that says it. The count itself is never truncated; that
 * happens here, in the label, and nowhere near the cache or a request.
 *
 * Metadata, not a control: it is inside the row's link and does nothing of its
 * own.
 */
function Count({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null;
  return (
    <span
      className="shrink-0 text-[11px] tabular-nums text-fg-subtle"
      title={n > COUNT_MAX ? `${label} ${n}개` : undefined}
    >
      {countLabel(n)}
    </span>
  );
}

function children(rows: MeetingCategory[], parent: number | null): MeetingCategory[] {
  return rows.filter((r) => r.parent_id === parent);
}

/** The folders that must be unfolded for `id` to be on screen: it, then upwards. */
function ancestry(rows: MeetingCategory[], id: number): Set<Folder> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain = new Set<Folder>();
  // `!chain.has(at)` is the stop condition as well as the dedupe: the server
  // refuses a cycle, and a tree that somehow held one must not hang the browser.
  for (let at: number | null = id; at !== null && !chain.has(at); at = byId.get(at)?.parent_id ?? null) {
    chain.add(at);
  }
  return chain;
}

/**
 * Where the reader is, as the separate questions the sidebar actually asks.
 *
 * These were one string — whatever `?category` held — and that is the whole bug
 * this replaced: on `/meetings/7` there is no category parameter, so "no filter"
 * and "not looking at a list at all" were both `""`, and 전체 회의 lit up on
 * every meeting page beside the meeting itself.
 *
 *   `filter`       the list on screen right now (`""` = 전체, `"none"` = 미분류,
 *                  otherwise a category id), or null when no list is on screen.
 *   `openMeeting`  the meeting whose page is open, or null.
 *
 * Which folders are unfolded is a third thing again, and it is component state
 * rather than route — see `open` in `CategoryNav`.
 */
function useSidebarRoute(): { filter: string | null; openMeeting: number | null } {
  const [params] = useSearchParams();
  // Three matches rather than `??` between them: `??` would make the second
  // call conditional, and these are hooks.
  const atRoot = useMatch("/");
  const atList = useMatch("/meetings");
  const atDetail = useMatch("/meetings/:meetingId");

  return {
    filter: atRoot || atList ? params.get("category") ?? "" : null,
    // `|| null` also swallows a non-numeric id, which matches no row.
    openMeeting: Number(atDetail?.params.meetingId) || null,
  };
}

/**
 * Unfolds the folders the open meeting is filed in.
 *
 * A component rather than a hook in `CategoryNav`, so that it runs only while a
 * meeting is actually open: mounted, it shares the detail page's cache entry for
 * the same meeting and costs no request of its own; unmounted, the sidebar asks
 * for nothing on a list page.
 *
 * Unfolding is not selecting. This decides what is *visible*, once, and the
 * reader can fold it straight back — which is why it adds to `open` instead of
 * being derived into it every render.
 */
function RevealFiling({
  id, rows, onFiled,
}: { id: number; rows: MeetingCategory[]; onFiled: (chain: Set<Folder>) => void }) {
  // `undefined` is "not loaded yet" and `null` is "filed nowhere" — the second
  // one has a folder to open (미분류) and the first one does not.
  const filedIn = useMeeting(id).data?.meeting.category_id;

  useEffect(() => {
    if (filedIn === undefined) return;
    onFiled(filedIn === null ? new Set<Folder>(["none"]) : ancestry(rows, filedIn));
  }, [filedIn, rows, onFiled]);

  return null;
}

/** The few most recent meetings filed in one folder, once it is open. */
function CategoryMeetings({
  category, onNavigate, indent, openMeeting, onFile, onDeleteMeeting, container = false,
}: {
  category: Folder;
  onNavigate: () => void;
  indent: number;
  openMeeting: number | null;
  onFile: (action: FilingAction) => void;
  onDeleteMeeting: (meeting: MeetingListRow) => void;
  /** Whether this folder holds other folders. Only changes what "empty" says. */
  container?: boolean;
}) {
  /* `descendants: 0` is what makes this a tree rather than a list of lists. The
     list page means a folder plus the work under it — ask for that here and a
     meeting in 업무 / 개발 is drawn under 개발 and again under 업무, two rows
     linking to one page and, on that page, two rows marked current. */
  const page = useMeetings({
    category, page_size: RECENT, sort: "held_desc", descendants: 0,
  });
  const rows = page.data?.items ?? [];
  // The page's own total, not the tree's count: they are the same number, and
  // this one is the answer to the request that produced these rows.
  const total = page.data?.total ?? rows.length;
  const style = { paddingLeft: `${indent * 0.75 + 2.25}rem` };

  if (page.isPending) return <SkeletonRows rows={1} className="px-2 py-1" />;
  if (rows.length === 0) {
    /* "아직 회의가 없습니다." is the answer for a folder you opened expecting
       meetings. Under a folder that holds other folders it lands beneath their
       contents and reads as theirs, and it is not news anyway — the folders are
       right there. */
    if (container) return null;
    return (
      <li className="py-1 text-[11px] text-fg-subtle" style={style}>
        아직 회의가 없습니다.
      </li>
    );
  }
  return (
    <>
      {rows.map((m) => {
        /* One rule for `aria-current="page"` across the whole sidebar: this link
           points at the URL you are on. It is the meeting's own page here and a
           filtered list above, and never two of them at once. */
        const isOpen = m.id === openMeeting;
        return (
          <li key={m.id} className="group relative flex items-center">
            <Link
              to={`/meetings/${m.id}`}
              onClick={onNavigate}
              title={m.display_title}
              aria-current={isOpen ? "page" : undefined}
              className={clsx(
                NAV_ROW, "min-w-0 flex-1 pr-7 text-[12px]",
                isOpen ? NAV_ROW_SELECTED : NAV_ROW_IDLE,
              )}
              style={style}
            >
              <span className="min-w-0 flex-1 truncate">{m.display_title}</span>
            </Link>
            {/* Over the row, not inside the link: a `<button>` inside an `<a>`
                is invalid and would navigate on its way to opening. Quiet until
                the row is hovered, focused, or the one you have open — and the
                link's `pr-7` is what keeps it off the ellipsis. */}
            <MeetingRowMenu
              meeting={m}
              onAct={onFile}
              onDelete={() => onDeleteMeeting(m)}
              className={clsx(
                "absolute top-1/2 right-1 -translate-y-1/2 focus-visible:opacity-100",
                "group-hover:opacity-100 data-[state=open]:opacity-100",
                isOpen ? "opacity-100" : "opacity-0",
              )}
            />
          </li>
        );
      })}
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
  row, rows, filter, openMeeting, open, onToggle, onNavigate, onEdit, onDelete, onFile,
  onDeleteMeeting,
}: {
  row: MeetingCategory;
  rows: MeetingCategory[];
  filter: string | null;
  openMeeting: number | null;
  open: Set<Folder>;
  onToggle: (id: Folder) => void;
  onNavigate: () => void;
  onEdit: (draft: Draft) => void;
  onDelete: (row: MeetingCategory) => void;
  onFile: (action: FilingAction) => void;
  onDeleteMeeting: (meeting: MeetingListRow) => void;
}) {
  const kids = children(rows, row.id);
  // Unfolded, and filtered by, and containing the open meeting are three
  // different facts about this row. Only the second one makes it the current
  // page; a meeting being open under it changes nothing here but the chevron.
  const expanded = open.has(row.id);
  const current = filter === String(row.id);

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
          aria-current={current ? "page" : undefined}
          title={row.path}
          className={clsx(NAV_ROW, "min-w-0 flex-1 pr-7", current ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
          style={{ paddingLeft: `${row.depth * 0.75 + 1.25}rem` }}
        >
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <Count n={row.meeting_count} label={row.name} />
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
              filter={filter}
              openMeeting={openMeeting}
              open={open}
              onToggle={onToggle}
              onNavigate={onNavigate}
              onEdit={onEdit}
              onDelete={onDelete}
              onFile={onFile}
              onDeleteMeeting={onDeleteMeeting}
            />
          ))}
          <CategoryMeetings
            category={row.id}
            indent={row.depth}
            onNavigate={onNavigate}
            openMeeting={openMeeting}
            onFile={onFile}
            onDeleteMeeting={onDeleteMeeting}
            container={kids.length > 0}
          />
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
  const { filter, openMeeting } = useSidebarRoute();
  const [open, setOpen] = useState<Set<Folder>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [doomed, setDoomed] = useState<MeetingCategory | null>(null);
  const [filing, setFiling] = useState<FilingAction | null>(null);
  const [doomedMeeting, setDoomedMeeting] = useState<MeetingListRow | null>(null);
  const rows = categories.data?.categories ?? [];
  // 전체 회의 and 미분류, counted by the server over the same access predicate
  // the meeting list uses. Undefined until the tree lands — `Count` draws
  // nothing for 0, which is also the right thing to draw for "not known yet".
  const nav = categories.data;
  const done = onNavigate ?? (() => undefined);

  const toggle = (id: Folder) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Returning `prev` unchanged when the chain is already open is what keeps
  // this from being a render loop: `RevealFiling` fires its effect again on
  // every new `rows` identity.
  const reveal = useCallback(
    (chain: Set<Folder>) =>
      setOpen((prev) => {
        const next = new Set([...prev, ...chain]);
        return next.size === prev.size ? prev : next;
      }),
    [],
  );

  return (
    <nav aria-label="카테고리 탐색" className="flex min-h-0 flex-1 flex-col px-2.5 py-2">
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
            {/* No chevron: 전체 회의 is not a folder, it is the whole list. The
                padding still leaves the twisty column empty so its icon lines up
                with 미분류's and with every category name below. */}
            <Link
              to="/"
              onClick={done}
              aria-current={filter === "" ? "page" : undefined}
              className={clsx(NAV_ROW, "pl-5", filter === "" ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
            >
              <Layers aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">전체 회의</span>
              <Count n={nav?.total ?? 0} label="전체 회의" />
            </Link>
          </li>
          <li>
            {/* 미분류 unfolds like any other folder. It holds meetings, and a
                sidebar that lists a folder's meetings but leaves this one as a
                dead end hides the meetings most in need of filing. */}
            <div className="relative flex items-center">
              <button
                type="button"
                aria-label={`미분류 ${open.has("none") ? "접기" : "펼치기"}`}
                aria-expanded={open.has("none")}
                onClick={() => toggle("none")}
                className="absolute left-0 rounded p-0.5 text-fg-subtle hover:text-fg"
              >
                <ChevronRight
                  aria-hidden
                  className={clsx("size-3.5 transition-transform", open.has("none") && "rotate-90")}
                />
              </button>
              <Link
                to={{ pathname: "/", search: "?category=none" }}
                onClick={done}
                aria-current={filter === "none" ? "page" : undefined}
                className={clsx(
                  NAV_ROW, "min-w-0 flex-1 pl-5",
                  filter === "none" ? NAV_ROW_ACTIVE : NAV_ROW_IDLE,
                )}
              >
                <Inbox aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">미분류</span>
                <Count n={nav?.uncategorized ?? 0} label="미분류" />
              </Link>
            </div>
          </li>
          {open.has("none") ? (
            <CategoryMeetings
              category="none"
              indent={0}
              onNavigate={done}
              openMeeting={openMeeting}
              onFile={setFiling}
              onDeleteMeeting={setDoomedMeeting}
            />
          ) : null}
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
                filter={filter}
                openMeeting={openMeeting}
                open={open}
                onToggle={toggle}
                onNavigate={done}
                onEdit={setDraft}
                onDelete={setDoomed}
                onFile={setFiling}
                onDeleteMeeting={setDoomedMeeting}
              />
            ))}
          </ul>
        )}
      </div>

      {openMeeting ? (
        <RevealFiling id={openMeeting} rows={rows} onFiled={reveal} />
      ) : null}

      {/* One dialog for the whole tree, whichever row's menu asked for it —
          the same component the meeting list mounts, writing the same filing
          row through the same hooks. */}
      <FilingDialog action={filing} onClose={() => setFiling(null)} />

      {/* And the same 삭제 the list and the detail page use, so a meeting can be
          removed from where you are looking at it. */}
      <DeleteMeetingDialog
        meeting={doomedMeeting}
        onClose={() => setDoomedMeeting(null)}
      />

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
    </nav>
  );
}
