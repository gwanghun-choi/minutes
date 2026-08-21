import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { MeetingFact, ParticipantRole } from "../../api/types";
import { Badge, FactStatusBadge } from "../../components/ui/Badge";
import { fmtDate, fmtTime } from "../../lib/format";
import { FACT_TYPE, ROLE } from "../../lib/labels";

const TYPE_TONE = { REQUEST: "info", DECISION: "primary", ACTION_ITEM: "warning" } as const;

/**
 * One structured fact with the words it came from.
 *
 * The excerpt is collapsed by default and always present: a claim with no
 * original text under it is not evidence, and a reviewer has to be able to open
 * it and check.
 */
export function FactCard({ fact }: { fact: MeetingFact }) {
  const [open, setOpen] = useState(false);
  const roles = Object.entries(fact.participants) as [ParticipantRole, string][];

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start gap-2">
        <Badge tone={TYPE_TONE[fact.fact_type]}>{FACT_TYPE[fact.fact_type]}</Badge>
        <p className="min-w-0 flex-1 text-sm font-medium text-fg">{fact.content}</p>
        <FactStatusBadge status={fact.status} />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
        {roles.map(([role, name]) => (
          <span key={role}>
            <span className="text-fg-subtle">{ROLE[role] ?? role}</span> {name}
          </span>
        ))}
        {fact.deadline_text ? (
          <span>
            <span className="text-fg-subtle">기한</span> {fact.deadline_text}
            {fact.deadline_at ? ` (${fmtDate(fact.deadline_at)})` : ""}
          </span>
        ) : null}
        <span className="tabular-nums">
          {fmtTime(fact.start_time)} ~ {fmtTime(fact.end_time)}
        </span>
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        <ChevronDown
          aria-hidden
          className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
        원문 {fact.source_segment_ids.length}개 발화
      </button>
      {open ? (
        <pre className="mt-1.5 rounded-md bg-surface-muted px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-fg">
          {fact.source_text}
        </pre>
      ) : null}
    </li>
  );
}
