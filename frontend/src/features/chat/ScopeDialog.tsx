import clsx from "clsx";
import { useMemo, useState } from "react";

import { useMeetings, useSetScope } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/controls";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorState, SkeletonRows } from "../../components/ui/feedback";
import { fmtDate } from "../../lib/format";

const RANGES = [
  { days: 7, label: "최근 7일" },
  { days: 30, label: "30일" },
  { days: 0, label: "전체" },
];

/**
 * Choose the meetings this chat searches. Empty means the whole corpus.
 *
 * The server is what makes a scope real: nothing local changes until the PATCH
 * succeeds, and a failure leaves both the dialog and the session as they were.
 *
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
  const setScope = useSetScope(sessionId);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(scope));
  const [query, setQuery] = useState("");
  // The cutoff is resolved when the button is pressed, not on every render:
  // "the last 7 days" has to mean one fixed instant while the list is open.
  const [range, setRange] = useState<{ days: number; cutoff: number | null }>({
    days: 0, cutoff: null,
  });

  // Only approved meetings are searchable, so only they can be scoped to.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cutoff = range.cutoff;
    return (meetings.data ?? [])
      .filter((m) => m.status === "COMPLETED")
      .filter(
        (m) =>
          (!q || m.title.toLowerCase().includes(q)) &&
          (!cutoff || new Date(m.held_at ?? m.created_at).getTime() >= cutoff),
      );
  }, [meetings.data, query, range]);

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="검색할 회의 선택"
      description="선택하지 않으면 전체 회의를 검색합니다."
      className="w-[min(34rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="flex-1 text-xs text-fg-muted">
            {picked.size ? `${picked.size}개 선택됨` : "전체 회의"}
          </span>
          <Button size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={setScope.isPending}
            onClick={() =>
              setScope.mutate([...picked], { onSuccess: onClose })
            }
          >
            선택 완료
          </Button>
        </>
      }
    >
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="회의명 검색"
        aria-label="회의명 검색"
      />

      <div role="group" aria-label="기간" className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-fg-muted">기간</span>
        {RANGES.map((r) => (
          <Button
            key={r.days}
            size="sm"
            variant={range.days === r.days ? "primary" : "ghost"}
            aria-pressed={range.days === r.days}
            onClick={() =>
              setRange({ days: r.days, cutoff: r.days ? Date.now() - r.days * 86_400_000 : null })
            }
          >
            {r.label}
          </Button>
        ))}
      </div>

      <div className="min-h-32 flex-1 overflow-y-auto rounded-md border border-border">
        {meetings.isPending ? (
          <SkeletonRows rows={4} className="p-3" />
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">
            해당하는 승인된 회의가 없습니다.
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
                    className="size-4 accent-[var(--color-primary)]"
                    checked={picked.has(m.id)}
                    onChange={() => toggle(m.id)}
                  />
                  <span className="w-24 shrink-0 text-xs text-fg-muted">
                    {m.held_at ? fmtDate(m.held_at) : `${fmtDate(m.created_at)} 등록`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">{m.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {setScope.isError ? <ErrorState error={setScope.error} /> : null}
    </Dialog>
  );
}
