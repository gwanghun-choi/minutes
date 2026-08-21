import { ChevronDown, Quote } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { ParticipantRole, RagSource } from "../../api/types";
import { Badge } from "../../components/ui/Badge";
import { FACT_TYPE, ROLE } from "../../lib/labels";

/**
 * Evidence, collapsed.
 *
 * The answer is what the reader wants; the sources are what makes it checkable.
 * They stay one click away and never outweigh the answer. Similarity scores are
 * retrieval diagnostics, not something a reader can act on, so they are kept in
 * the stored payload and left off the screen.
 */
export function SourceList({ sources }: { sources: RagSource[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
      >
        <ChevronDown
          aria-hidden
          className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
        근거 {sources.length}개
      </button>

      {open ? (
        <ul className="mt-2 space-y-2">
          {sources.map((s) => (
            <li
              key={`${s.kind}-${s.index}`}
              className="rounded-md border border-border bg-surface-muted px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-semibold text-fg-subtle">[{s.index}]</span>
                {s.kind === "fact" && s.fact_type ? (
                  <Badge tone="primary">{FACT_TYPE[s.fact_type]}</Badge>
                ) : null}
                <Link
                  to={`/meetings/${s.meeting_id}`}
                  className="font-medium text-primary hover:underline"
                >
                  {s.meeting_title}
                </Link>
                {s.meeting_date_label ? (
                  <span className="text-fg-muted">{s.meeting_date_label}</span>
                ) : null}
                <span className="text-fg-muted tabular-nums">{s.time_label}</span>
              </div>

              {s.kind === "fact" ? (
                <p className="mt-1.5 text-xs text-fg">
                  {s.summary}
                  {s.participants
                    ? (Object.entries(s.participants) as [ParticipantRole, string][]).map(
                        ([role, name]) => (
                          <span key={role} className="ml-2 text-fg-muted">
                            {ROLE[role] ?? role} {name}
                          </span>
                        ),
                      )
                    : null}
                  {s.deadline_text ? (
                    <span className="ml-2 text-fg-muted">기한 {s.deadline_text}</span>
                  ) : null}
                  {s.status_label ? (
                    <span className="ml-2 text-fg-muted">{s.status_label}</span>
                  ) : null}
                </p>
              ) : null}

              <p className="mt-1 text-xs text-fg-muted">
                화자 {s.speakers.length ? s.speakers.join(", ") : "-"}
              </p>

              <div className="mt-1.5 flex gap-1.5">
                <Quote aria-hidden className="mt-0.5 size-3 shrink-0 text-fg-subtle" />
                <pre className="min-w-0 flex-1 text-xs leading-relaxed whitespace-pre-wrap text-fg">
                  {s.text}
                </pre>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
