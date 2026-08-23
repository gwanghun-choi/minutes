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
 * What is in it is what the answer cited, and nothing else. Retrieval sends
 * Top-K candidates and the model quotes the ones it used; the rest are the
 * provenance of the *search*, not of this answer, and putting them in the same
 * list meant "출처 6개" under an answer resting on two and four unquoted cards
 * mixed in with the two that mattered. The server decides which is which
 * (`rag.cited_sources`), from the `[N]` markers in the answer itself.
 *
 * Nothing was dropped to make that true. The full retrieved set is still in the
 * response and still in `chat_messages.sources`; it is simply not evidence for a
 * claim nobody made from it.
 *
 * What stays off the screen either way is retrieval diagnostics: similarity and
 * RRF scores, chunk ids, fact ids. They are still in the payload, and a reader
 * cannot act on them.
 */
export function SourceTrigger({
  sources, open, onToggle,
}: {
  /** The cited sources — the count on this button is their number, exactly. */
  sources: RagSource[];
  open: boolean;
  onToggle: () => void;
}) {
  // An answer that quoted nothing has no 출처, and a control that opens an empty
  // panel is worse than no control.
  if (sources.length === 0) return null;
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
      출처 {sources.length}개
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
        "rounded-md border bg-surface px-3 py-2.5 transition-colors",
        selected ? "border-primary ring-1 ring-primary/25" : "border-border",
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
        <div className="mt-1.5">
          <p className="text-xs font-medium text-fg">{s.summary}</p>
          {/* Who and by when, as separate items on their own row. Run together
              with the claim they read as one unpunctuated sentence. */}
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
            {roles.map(([role, name]) => (
              <span key={role}>
                <span className="text-fg-subtle">{ROLE[role] ?? role}</span> {name}
              </span>
            ))}
            {s.deadline_text ? (
              <span>
                <span className="text-fg-subtle">기한</span> {s.deadline_text}
              </span>
            ) : null}
            {s.status_label ? <span>{s.status_label}</span> : null}
          </div>
        </div>
      ) : null}

      {/* Full words, not a clamp: opening this panel is the reader asking to
          check the answer, and a truncated quotation cannot be checked. */}
      <p className="mt-1.5 border-l-2 border-border pl-2.5 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted">
        {s.text}
      </p>

      {/* `at` is the offset the transcript scrolls to and highlights. The
          segments themselves are `source_segment_ids`, which stay in the payload
          as provenance; the reading position is a time, which is what the
          transcript is laid out by. */}
      <Link
        to={`/meetings/${s.meeting_id}?tab=transcript&at=${s.start_time}`}
        className="mt-2 inline-block text-[11px] font-medium text-primary hover:underline"
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
  sources, selected, open, onClose,
}: {
  /** The cited sources, exactly as the trigger counted them. */
  sources: RagSource[];
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

  return (
    <>
      {/* Below md the drawer covers the conversation, so a tap outside it has to
          be able to close it. From md it is beside the reading column and the
          conversation stays usable, so there is nothing to dismiss. */}
      <div
        aria-hidden
        onClick={onClose}
        className={clsx(
          "fixed inset-0 z-40 bg-fg/20 transition-opacity duration-200 md:hidden",
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
        /* Absolute inside the conversation region from `md`, so it stops at the
           page header instead of covering the account and the 범위 변경 button
           that opened it. Below `md` there is no fixed-height region to sit in
           and 380px of a phone is not a panel, so it covers the viewport. */
        className={clsx(
          "fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border",
          "md:absolute md:z-20",
          "bg-bg shadow-pop transition-transform duration-200 ease-out sm:w-[24rem]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3.5 py-2.5">
          <h2 className="text-section min-w-0 flex-1">
            출처
            <span className="ml-1.5 font-normal text-fg-subtle tabular-nums">
              {sources.length}
            </span>
          </h2>
          <Button
            size="sm"
            variant="ghost"
            aria-label="출처 닫기"
            onClick={onClose}
            icon={<X aria-hidden className="size-4" />}
          />
        </div>

        <p className="border-b border-border px-3.5 py-2 text-[11px] text-fg-subtle">
          답변이 인용한 회의록 원문입니다.
        </p>

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {sources.map((s) => (
            <Card key={`${s.kind}-${s.index}`} source={s} selected={s.index === selected} />
          ))}
        </ul>
      </aside>
    </>
  );
}
