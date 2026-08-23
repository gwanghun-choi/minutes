import clsx from "clsx";
import type { ReactNode } from "react";

import type {
  FactStatus, IntelligenceState, MeetingStatus, ShareStatus, VersionStatus,
} from "../../api/types";
import {
  FACT_STATUS, INTEL_STATE, MEETING_STATUS, SHARE_STATUS, VERSION_STATUS,
} from "../../lib/labels";

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
}: { tone?: Tone; className?: string | undefined; children: ReactNode }) {
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

/* A pending invitation is waiting on a person, which is the same kind of state
   as 검토 필요 — so it wears the same tone. */
const SHARE_TONE: Record<ShareStatus, Tone> = {
  PENDING: "warning",
  ACCEPTED: "success",
  REJECTED: "neutral",
  REVOKED: "neutral",
};

/* Only the published revision is being shown and searched, so only it is green.
   A draft is not a lesser version of that; it is not one at all yet. */
const VERSION_TONE: Record<VersionStatus, Tone> = {
  DRAFT: "warning",
  INDEXING: "info",
  PUBLISHED: "success",
  SUPERSEDED: "neutral",
};

/**
 * 공유 — this meeting belongs to somebody else and I was invited to read it.
 *
 * Derived from permission, never from text. Nothing writes "[공유]" into a title
 * or an alias: `is_owner` on a list row and `role` on the detail response are
 * what the server computed, so renaming the meeting on my own screen, filing it
 * somewhere else, or finding it through a search cannot take the marker off it.
 *
 * There is no matching 내 회의 badge. A badge on every row is a column, and the
 * thing worth noticing is the exception.
 */
export const SharedBadge = ({ className }: { className?: string }) => (
  <Badge tone="info" className={className}>
    공유
  </Badge>
);

export const MeetingStatusBadge = ({ status }: { status: MeetingStatus }) => (
  <Badge tone={MEETING_TONE[status]}>{MEETING_STATUS[status] ?? status}</Badge>
);

export const IntelStateBadge = ({ state }: { state: IntelligenceState }) => (
  <Badge tone={INTEL_TONE[state]}>{INTEL_STATE[state] ?? state}</Badge>
);

export const FactStatusBadge = ({ status }: { status: FactStatus }) => (
  <Badge tone={FACT_TONE[status]}>{FACT_STATUS[status] ?? status}</Badge>
);

export const ShareStatusBadge = ({ status }: { status: ShareStatus }) => (
  <Badge tone={SHARE_TONE[status]}>{SHARE_STATUS[status] ?? status}</Badge>
);

export const VersionStatusBadge = ({ status }: { status: VersionStatus }) => (
  <Badge tone={VERSION_TONE[status]}>{VERSION_STATUS[status] ?? status}</Badge>
);
