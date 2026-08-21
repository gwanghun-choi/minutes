import clsx from "clsx";
import { ChevronDown, Quote } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { ParticipantRole, RagSource } from "../../api/types";
import { Badge } from "../../components/ui/Badge";
import { FACT_TYPE, ROLE } from "../../lib/labels";

function SourceRow({ source: s }: { source: RagSource }) {
  const roles = Object.entries(s.participants ?? {}) as [ParticipantRole, string][];
  return (
    <li className="border-l-2 border-border pl-2.5">
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
        <span className="tabular-nums">· {s.time_label}</span>
        {s.speakers.length ? <span>· {s.speakers.join(", ")}</span> : null}
      </div>

      {/* A structured source shows what was extracted; the transcript words
          under it are what make it checkable, so both are always present. */}
      {s.kind === "fact" ? (
        <p className="mt-1 text-xs text-fg">
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

      {/* Full words, not a clamp: opening this section is the reader asking to
          check the answer, and a truncated quotation cannot be checked. */}
      <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted">{s.text}</p>
    </li>
  );
}

/**
 * Evidence under an answer, closed until asked for.
 *
 * The answer is what the reader came for; the evidence is what makes it
 * checkable, and six excerpts printed under every paragraph bury the paragraph.
 * So the default state is one quiet line — the count, which is honest about the
 * whole retrieved set — and everything opens together from there.
 *
 * Nothing is dropped to make this quieter. Retrieval still runs at Top-K over
 * both layers, the generator still receives every retrieved source, and the
 * whole list is still in the response and in `chat_messages.sources`. Similarity
 * scores and chunk ids stay in that payload and off the screen: they are
 * retrieval diagnostics a reader cannot act on.
 */
export function SourceList({ sources }: { sources: RagSource[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface",
          "px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors",
          "hover:border-border-strong hover:text-fg",
        )}
      >
        <Quote aria-hidden className="size-3.5" />
        {open ? "근거 접기" : `근거 ${sources.length}개 보기`}
        <ChevronDown
          aria-hidden
          className={clsx("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <ul className="mt-2 space-y-2.5 rounded-md border border-border bg-surface px-3 py-3">
          {sources.map((s) => (
            <SourceRow key={`${s.kind}-${s.index}`} source={s} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
