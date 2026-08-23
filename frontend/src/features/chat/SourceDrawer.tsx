import clsx from "clsx";
import { Quote, X } from "lucide-react";
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
  sources, cited, open, onToggle,
}: {
  sources: RagSource[];
  /** The `[N]` markers this answer actually wrote. */
  cited: Set<number>;
  open: boolean;
  onToggle: () => void;
}) {
  if (sources.length === 0) return null;
  /*
    The number describes the answer, not the search. Retrieval sends a fixed
    number of candidates and the model cites the ones it used, so counting
    candidates here would tell a reader "출처 6개" about an answer resting on two.
    The drawer still contains every candidate — nothing is dropped from the
    payload or from storage, and the drawer says how many were not cited.
  */
  const count = cited.size || sources.length;
  const label = cited.size ? `출처 ${count}개` : `검색 결과 ${count}개`;
  return (
    <button
      type="button"
      onClick={onToggle}
      /* No aria-label: the visible text is the name, and `aria-expanded` is what
         says whether pressing it opens or closes. */
      aria-expanded={open}
      className={clsx(
        "mt-2.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1",
        "text-xs font-medium transition-colors",
        open
          ? "bg-primary-soft text-primary"
          : "text-fg-muted hover:bg-surface-muted hover:text-fg",
      )}
    >
      <Quote aria-hidden className="size-3.5" />
      {label}
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

function Card({
  source: s, selected, cited,
}: { source: RagSource; selected: boolean; cited: boolean }) {
  const roles = Object.entries(s.participants ?? {}) as [ParticipantRole, string][];
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  /*
    The answer was given while this account could read the meeting, and it no
    longer can — the owner took the share back, or deleted it. The server sends
    the citation with the excerpt stripped, so the numbering in the answer still
    resolves and the reader is told why the card is empty. There is nothing to
    link to and nothing to quote.
  */
  if (s.revoked) {
    return (
      <li
        ref={ref}
        id={`source-${s.index}`}
        className={clsx(
          "rounded-md border border-dashed px-3 py-2.5 transition-colors",
          selected ? "border-primary bg-primary-soft/40" : "border-border bg-surface",
        )}
      >
        <div className="flex items-baseline gap-1.5 text-[11px] text-fg-muted">
          <span className="font-medium text-fg-subtle">[{s.index}]</span>
          <span>{s.meeting_title}</span>
        </div>
        <p className="mt-1.5 text-xs text-fg-muted">
          이 회의에 더 이상 접근할 수 없어 근거 원문을 표시하지 않습니다.
        </p>
      </li>
    );
  }

  return (
    <li
      ref={ref}
      id={`source-${s.index}`}
      className={clsx(
        "rounded-md border px-3 py-2.5 transition-colors",
        selected ? "border-primary bg-primary-soft/40" : "border-border bg-surface",
        !cited && "opacity-80",
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
        {/* Which revision of the minutes this quotation is from. Shown only
            once a meeting has actually been revised — "v1" on every card would
            be noise. */}
        {s.meeting_version && s.meeting_version > 1 ? <span>· v{s.meeting_version}</span> : null}
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

/**
 * The 출처 drawer: off-canvas, and genuinely so.
 *
 * It is always mounted and always positioned; what changes is `translate-x`, so
 * opening and closing is one transform the compositor animates and the
 * conversation beneath never reflows. Conditional rendering used to make the
 * chat column jump its full width in a single frame.
 *
 * An overlay, not a push. Evidence is secondary to the answer, so the reading
 * column keeps its measure and its centre axis while the drawer sits over the
 * right of it — which is also what makes the same component work below `md`,
 * where it covers the screen because 380px of a phone is not a panel.
 *
 * `inert` while closed keeps it out of the tab order and out of a screen
 * reader's way without a second rendering path to drift.
 */
export function SourceDrawer({
  sources, cited, selected, open, onClose,
}: {
  sources: RagSource[];
  /** The `[N]` markers the answer wrote. Empty when it cited nothing. */
  cited: Set<number>;
  /** The citation the reader clicked, or null when the whole list was opened. */
  selected: number | null;
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const uncited = cited.size ? sources.filter((s) => !cited.has(s.index)).length : 0;

  return (
    <>
      {/* Below md the drawer covers the conversation, so a tap outside it has to
          be able to close it. From md it is beside the reading column and the
          conversation stays usable, so there is nothing to dismiss. */}
      <div
        aria-hidden
        onClick={onClose}
        className={clsx(
          "fixed inset-0 z-30 bg-fg/20 transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        aria-label="출처"
        /* Closed, it is off-canvas but still in the document so it can slide.
           `inert` takes it out of the tab order; `aria-hidden` takes it out of
           the accessibility tree, so nothing is announced for a panel that is
           not on screen. */
        inert={!open}
        aria-hidden={!open}
        className={clsx(
          "fixed top-0 right-0 bottom-0 z-40 flex w-full flex-col border-l border-border",
          "bg-bg shadow-xl transition-transform duration-200 ease-out sm:w-[24rem]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5">
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">출처</h2>
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
            <Card
              key={`${s.kind}-${s.index}`}
              source={s}
              selected={s.index === selected}
              cited={cited.size === 0 || cited.has(s.index)}
            />
          ))}
        </ul>
        {/* Every retrieved candidate is here, including the ones the answer did
            not quote. Saying so is what keeps the button's count honest without
            hiding evidence. */}
        {uncited > 0 ? (
          <p className="border-t border-border px-3 py-2 text-[11px] text-fg-subtle">
            답변이 인용하지 않은 검색 결과 {uncited}개도 함께 표시됩니다.
          </p>
        ) : null}
      </aside>
    </>
  );
}
