import clsx from "clsx";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useCategories, useMeetings, useSetScope } from "../../api/queries";
import { MeetingStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/controls";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorState, SkeletonRows } from "../../components/ui/feedback";
import { fmtDate } from "../../lib/format";
import { matches, RANGES, type MeetingQuery } from "../../lib/meetings";

/**
 * Choose the meetings this chat searches.
 *
 * The two states the backend has — an empty array meaning the whole corpus, and
 * a list meaning a hard restriction — are shown as the two modes they are,
 * rather than left as the hidden rule "select nothing and you get everything".
 * What is sent is still exactly those two shapes.
 *
 * The server is what makes a scope real: nothing local changes until the PATCH
 * succeeds, and a failure leaves both the dialog and the session as they were.
 * The caller mounts this only while it is open, so every opening starts from
 * what the session actually has rather than from a stale pick.
 */
export function ScopeDialog({
  onClose, sessionId, scope,
}: {
  onClose: () => void;
  sessionId: number;
  scope: number[];
}) {
  const meetings = useMeetings();
  const categories = useCategories();
  const setScope = useSetScope(sessionId);

  const [mode, setMode] = useState<"all" | "picked">(scope.length ? "picked" : "all");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(scope));
  const [query, setQuery] = useState<MeetingQuery>({
    text: "", category: "", status: "", cutoff: null,
  });
  // Which range button is lit. The cutoff itself is resolved when the button is
  // pressed, not on every render: "the last 7 days" has to mean one fixed
  // instant while the list is open.
  const [days, setDays] = useState(0);

  // Only approved meetings are searchable, so only they can be scoped to.
  const rows = useMemo(
    () => (meetings.data ?? []).filter((m) => m.status === "COMPLETED" && matches(m, query)),
    [meetings.data, query],
  );

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      // Ticking a meeting is the same intent as switching mode; making the user
      // do both would be a trap where a tick silently means nothing.
      setMode(next.size ? "picked" : "all");
      return next;
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="검색할 회의 선택"
      description="검색 가능한 완료 회의만 표시됩니다."
      className="w-[min(38rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="flex-1 text-xs text-fg-muted">
            {mode === "all"
              ? "전체 회의"
              : picked.size
                ? `${picked.size}개 선택됨`
                : "회의를 하나 이상 고르세요."}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={picked.size === 0 && mode === "all"}
            onClick={() => {
              setPicked(new Set());
              setMode("all");
            }}
          >
            초기화
          </Button>
          <Button size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={setScope.isPending}
            disabled={mode === "picked" && picked.size === 0}
            onClick={() =>
              // GLOBAL is the empty array, exactly as the backend defines it.
              setScope.mutate(mode === "all" ? [] : [...picked], { onSuccess: onClose })
            }
          >
            선택 완료
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="검색 범위" className="flex flex-wrap gap-1.5">
        {(
          [
            ["all", "전체 회의"],
            ["picked", "선택한 회의"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => setMode(value)}
            className={clsx(
              "rounded-md border px-2.5 py-1 text-[13px] font-medium transition-colors",
              mode === value
                ? "border-primary bg-primary-soft text-primary"
                : "border-border text-fg-muted hover:bg-surface-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            value={query.text}
            onChange={(e) => setQuery({ ...query, text: e.target.value })}
            placeholder="회의명 검색"
            aria-label="회의명 검색"
            className="pl-8"
          />
        </div>
        <Select
          value={query.category}
          onChange={(e) => setQuery({ ...query, category: e.target.value })}
          aria-label="카테고리로 거르기"
          className="w-36"
        >
          <option value="">모든 카테고리</option>
          <option value="none">미분류</option>
          {(categories.data ?? []).map((k) => (
            <option key={k.id} value={String(k.id)}>
              {k.name}
            </option>
          ))}
        </Select>
        <Select
          value={String(days)}
          onChange={(e) => {
            const next = Number(e.target.value);
            setDays(next);
            setQuery({ ...query, cutoff: next ? Date.now() - next * 86_400_000 : null });
          }}
          aria-label="기간으로 거르기"
          className="w-32"
        >
          {RANGES.map((r) => (
            <option key={r.days} value={String(r.days)}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="min-h-32 flex-1 overflow-y-auto rounded-md border border-border">
        {meetings.isPending ? (
          <SkeletonRows rows={4} className="p-3" />
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">
            조건에 맞는 완료 회의가 없습니다.
          </p>
        ) : (
          <ul>
            {rows.map((m) => (
              <li key={m.id}>
                <label
                  className={clsx(
                    "flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-sm last:border-0",
                    picked.has(m.id) ? "bg-primary-soft" : "hover:bg-surface-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--color-primary)]"
                    checked={picked.has(m.id)}
                    onChange={() => toggle(m.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fg">{m.title}</span>
                    <span className="text-xs text-fg-muted">
                      {m.category_name ?? "미분류"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs whitespace-nowrap text-fg-muted">
                    {m.held_at ? fmtDate(m.held_at) : `${fmtDate(m.created_at)} 등록`}
                  </span>
                  <MeetingStatusBadge status={m.status} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode === "all" && picked.size > 0 ? (
        <p className="text-xs text-fg-muted">
          전체 회의로 검색합니다. 고른 {picked.size}개는 [선택한 회의]로 바꾸면 적용됩니다.
        </p>
      ) : null}

      {setScope.isError ? <ErrorState error={setScope.error} /> : null}
    </Dialog>
  );
}
