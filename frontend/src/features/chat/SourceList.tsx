import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { ParticipantRole, RagSource } from "../../api/types";
import { Badge } from "../../components/ui/Badge";
import { FACT_TYPE, ROLE } from "../../lib/labels";

/**
 * How many sources the reader sees before asking for more.
 *
 * This is a presentation figure and nothing else. Retrieval still runs at
 * Top-K over both layers, the model still receives every retrieved source, and
 * the whole list is still in the response and in `chat_messages.sources` — a
 * source is never dropped to make the screen quieter.
 */
const HEAD = 2;

function SourceRow({ source: s, full }: { source: RagSource; full: boolean }) {
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

      <p
        className={clsx(
          "mt-1 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted",
          !full && "line-clamp-2",
        )}
      >
        {s.text}
      </p>
    </li>
  );
}

/**
 * Evidence under an answer.
 *
 * The answer is what the reader wants; the sources are what make it checkable.
 * Two representative ones are visible and the rest are one click away, so six
 * excerpts never out-shout the paragraph they support. Similarity scores are
 * retrieval diagnostics a reader cannot act on: kept in the stored payload,
 * left off the screen.
 */
export function SourceList({ sources }: { sources: RagSource[] }) {
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;

  const shown = expanded ? sources : sources.slice(0, HEAD);
  const hidden = sources.length - shown.length;

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <p className="mb-2 text-[11px] font-medium text-fg-subtle">근거 {sources.length}개</p>
      <ul className="space-y-2.5">
        {shown.map((s) => (
          <SourceRow key={`${s.kind}-${s.index}`} source={s} full={expanded} />
        ))}
      </ul>
      {sources.length > HEAD ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
        >
          <ChevronDown
            aria-hidden
            className={clsx("size-3.5 transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "근거 접기" : `근거 ${hidden}개 더 보기`}
        </button>
      ) : null}
    </div>
  );
}
