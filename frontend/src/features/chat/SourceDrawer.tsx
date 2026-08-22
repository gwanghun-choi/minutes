import clsx from "clsx";
import { ChevronRight, Quote, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";

import type { ParticipantRole, RagSource } from "../../api/types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { FACT_TYPE, ROLE } from "../../lib/labels";

/**
 * 출처 — the evidence panel, beside the answer rather than under it.
 *
 * The user-facing word is 출처. Nothing about grounding changed: these are the
 * same rows `rag.serialize_sources` returns and `chat_messages.sources` stores,
 * in the same order, with the same `source_segment_ids`. The panel is a
 * presentation of the whole retrieved set — it never shows fewer sources than
 * the answer rested on, and the backend never returns fewer because of it.
 *
 * What stays off the screen is retrieval diagnostics: similarity and RRF scores,
 * chunk ids, fact ids. They are still in the payload, and a reader cannot act on
 * them.
 */
export function SourceTrigger({
  count, open, onOpen,
}: { count: number; open: boolean; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      className={clsx(
        "mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
        "text-xs font-medium transition-colors",
        open
          ? "border-primary bg-primary-soft text-primary"
          : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
      )}
    >
      <Quote aria-hidden className="size-3.5" />
      출처 {count}개
      <ChevronRight aria-hidden className="size-3.5" />
    </button>
  );
}

/** One citation marker inside an answer. Opens the panel on that source. */
export function Citation({ n, onSelect }: { n: number; onSelect: (n: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(n)}
      aria-label={`출처 ${n} 보기`}
      className="mx-0.5 inline-flex min-w-4 items-center justify-center rounded bg-primary-soft px-1 align-baseline text-[11px] font-medium text-primary tabular-nums hover:bg-primary hover:text-primary-fg"
    >
      {n}
    </button>
  );
}

function Card({ source: s, selected }: { source: RagSource; selected: boolean }) {
  const roles = Object.entries(s.participants ?? {}) as [ParticipantRole, string][];
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <li
      ref={ref}
      id={`source-${s.index}`}
      className={clsx(
        "rounded-md border px-3 py-2.5",
        selected ? "border-primary bg-primary-soft/40" : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11px] text-fg-muted">
        <span className="font-medium text-fg-subtle">[{s.index}]</span>
        {s.kind === "fact" && s.fact_type ? (
          <Badge tone="neutral" className="px-1.5 py-0 text-[11px]">
            {FACT_TYPE[s.fact_type]}
          </Badge>
        ) : null}
        <Link to={`/meetings/${s.meeting_id}`} className="font-medium text-fg hover:underline">
          {s.meeting_title}
        </Link>
        {s.meeting_date_label ? <span>· {s.meeting_date_label}</span> : null}
      </div>

      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-fg-muted">
        <span className="tabular-nums">{s.time_label}</span>
        {s.speakers.length ? <span>· {s.speakers.join(", ")}</span> : null}
      </div>

      {/* A structured source shows what was extracted; the transcript words
          under it are what make it checkable, so both are always present. */}
      {s.kind === "fact" ? (
        <p className="mt-1.5 text-xs text-fg">
          {s.summary}
          {roles.map(([role, name]) => (
            <span key={role} className="ml-2 text-fg-muted">
              {ROLE[role] ?? role} {name}
            </span>
          ))}
          {s.deadline_text ? <span className="ml-2 text-fg-muted">기한 {s.deadline_text}</span> : null}
          {s.status_label ? <span className="ml-2 text-fg-muted">{s.status_label}</span> : null}
        </p>
      ) : null}

      {/* Full words, not a clamp: opening this panel is the reader asking to
          check the answer, and a truncated quotation cannot be checked. */}
      <p className="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted">{s.text}</p>

      {/* `at` is the offset the transcript scrolls to and highlights. The
          segments themselves are `source_segment_ids`, which stay in the payload
          as provenance; the reading position is a time, which is what the
          transcript is laid out by. */}
      <Link
        to={`/meetings/${s.meeting_id}?tab=transcript&at=${s.start_time}`}
        className="mt-1.5 inline-block text-[11px] font-medium text-primary hover:underline"
      >
        회의록에서 보기
      </Link>
    </li>
  );
}

export function SourceDrawer({
  sources, selected, onClose,
}: {
  sources: RagSource[];
  /** The citation the reader clicked, or null when the whole list was opened. */
  selected: number | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="출처"
      className={clsx(
        // Below md it is a full-width sheet over the conversation; from md it is
        // a column beside it, so the answer stays readable next to its evidence.
        "fixed inset-0 z-40 flex flex-col border-border bg-bg",
        "md:static md:z-auto md:w-80 md:shrink-0 md:border-l lg:w-96",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">
          출처 {sources.length}개
        </h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label="출처 닫기"
          onClick={onClose}
          icon={<X aria-hidden className="size-4" />}
        />
      </div>

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {sources.map((s) => (
          <Card key={`${s.kind}-${s.index}`} source={s} selected={s.index === selected} />
        ))}
      </ul>
    </aside>
  );
}
