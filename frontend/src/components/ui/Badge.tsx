import clsx from "clsx";
import type { ReactNode } from "react";

import type { FactStatus, IntelligenceState, MeetingStatus } from "../../api/types";
import { FACT_STATUS, INTEL_STATE, MEETING_STATUS } from "../../lib/labels";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-muted text-fg-muted",
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Badge({
  tone = "neutral", className, children,
}: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone], className,
      )}
    >
      {children}
    </span>
  );
}

/* One tone per state, defined once. The same status is the same colour on the
   list, the detail header, and the chat source card. */
const MEETING_TONE: Record<MeetingStatus, Tone> = {
  UPLOADED: "info",
  TRANSCRIBING: "info",
  DIARIZING: "info",
  REVIEW_REQUIRED: "warning",
  INDEXING: "info",
  COMPLETED: "success",
  FAILED: "danger",
};

const INTEL_TONE: Record<IntelligenceState, Tone> = {
  NOT_BUILT: "neutral",
  BUILDING: "info",
  READY: "success",
  FAILED: "danger",
};

/** UNKNOWN stays neutral on purpose: it is not a kind of "open". */
const FACT_TONE: Record<FactStatus, Tone> = {
  UNKNOWN: "neutral",
  OPEN: "info",
  DONE: "success",
  CANCELLED: "neutral",
  DEFERRED: "warning",
};

export const MeetingStatusBadge = ({ status }: { status: MeetingStatus }) => (
  <Badge tone={MEETING_TONE[status]}>{MEETING_STATUS[status] ?? status}</Badge>
);

export const IntelStateBadge = ({ state }: { state: IntelligenceState }) => (
  <Badge tone={INTEL_TONE[state]}>{INTEL_STATE[state] ?? state}</Badge>
);

export const FactStatusBadge = ({ status }: { status: FactStatus }) => (
  <Badge tone={FACT_TONE[status]}>{FACT_STATUS[status] ?? status}</Badge>
);
