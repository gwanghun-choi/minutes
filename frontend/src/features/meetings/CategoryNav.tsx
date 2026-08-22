import clsx from "clsx";
import { ChevronRight, Inbox, Layers } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { useCategories } from "../../api/queries";
import type { MeetingCategory } from "../../api/types";
import { NAV_ROW, NAV_ROW_ACTIVE, NAV_ROW_IDLE } from "../../components/AppShell";
import { SkeletonRows } from "../../components/ui/feedback";

/**
 * The category tree, in the app's one sidebar.
 *
 * It sits where the chat list sits on the chat route — the same element, the same
 * row style, mounted once. A category is somewhere you navigate to, so it belongs
 * with the navigation rather than in a second panel beside the list.
 *
 * Every row is a link that writes `?category=` on the meeting list, which is the
 * only state these two share. Management is not here: the list toolbar links to
 * `/categories`, and one link to it is enough. Selecting a parent is *not* a shorthand for
 * selecting its children: the server matches the whole subtree
 * (`app/api/categories.py:SUBTREE`), so a parent genuinely returns the meetings
 * filed under everything below it.
 */
function children(rows: MeetingCategory[], parent: number | null): MeetingCategory[] {
  return rows.filter((r) => r.parent_id === parent);
}

function Row({
  row, rows, active, collapsed, onToggle, onNavigate,
}: {
  row: MeetingCategory;
  rows: MeetingCategory[];
  active: string;
  collapsed: Set<number>;
  onToggle: (id: number) => void;
  onNavigate: () => void;
}) {
  const kids = children(rows, row.id);
  const open = !collapsed.has(row.id);
  const selected = active === String(row.id);

  return (
    <li>
      <div className="group relative flex items-center">
        {kids.length > 0 ? (
          <button
            type="button"
            aria-label={`${row.name} ${open ? "접기" : "펼치기"}`}
            aria-expanded={open}
            onClick={() => onToggle(row.id)}
            className="absolute left-0 rounded p-0.5 text-fg-subtle hover:text-fg"
            style={{ marginLeft: `${row.depth * 0.75}rem` }}
          >
            <ChevronRight
              aria-hidden
              className={clsx("size-3.5 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : null}
        <Link
          to={{ pathname: "/", search: `?category=${row.id}` }}
          onClick={onNavigate}
          aria-current={selected ? "page" : undefined}
          title={row.path}
          className={clsx(
            NAV_ROW,
            "min-w-0 flex-1",
            selected ? NAV_ROW_ACTIVE : NAV_ROW_IDLE,
          )}
          style={{ paddingLeft: `${row.depth * 0.75 + 1.25}rem` }}
        >
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          {row.meeting_count > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">
              {row.meeting_count}
            </span>
          ) : null}
        </Link>
      </div>
      {kids.length > 0 && open ? (
        <ul>
          {kids.map((k) => (
            <Row
              key={k.id}
              row={k}
              rows={rows}
              active={active}
              collapsed={collapsed}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function CategoryNav({ onNavigate }: { onNavigate?: () => void }) {
  const categories = useCategories();
  const [params] = useSearchParams();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const rows = categories.data ?? [];
  const active = params.get("category") ?? "";
  const done = onNavigate ?? (() => undefined);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2.5 py-2">
      <h2 className="px-2 pb-1 text-[11px] font-medium text-fg-subtle">카테고리</h2>

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
          <p className="px-2 py-2 text-xs text-fg-muted">아직 카테고리가 없습니다.</p>
        ) : (
          <ul className="mt-1">
            {children(rows, null).map((row) => (
              <Row
                key={row.id}
                row={row}
                rows={rows}
                active={active}
                collapsed={collapsed}
                onToggle={toggle}
                onNavigate={done}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
