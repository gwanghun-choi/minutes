import clsx from "clsx";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { errorMessage } from "../../api/client";

export const Spinner = ({ className }: { className?: string }) => (
  <Loader2 aria-hidden className={clsx("size-4 animate-spin text-fg-subtle", className)} />
);

const Skeleton = ({ className }: { className?: string }) => (
  <div className={clsx("animate-pulse rounded bg-surface-muted", className)} />
);

/** A block of skeleton rows, for a list that has not arrived yet. */
export const SkeletonRows = ({ rows = 4, className }: { rows?: number; className?: string }) => (
  <div className={clsx("space-y-2", className)} aria-busy aria-label="불러오는 중">
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className="h-9 w-full" />
    ))}
  </div>
);

export function EmptyState({
  icon, title, hint, action,
}: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon ? <div className="text-fg-subtle">{icon}</div> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint ? <p className="max-w-md text-xs text-fg-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

/** Failure that the user has to see, with the server's own message. */
export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-danger">{errorMessage(error)}</p>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Small contextual message beside the control that produced it. */
export function InlineNote({
  tone = "muted", children,
}: { tone?: "muted" | "error" | "success"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "text-xs",
        tone === "error" && "text-danger",
        tone === "success" && "text-success",
        tone === "muted" && "text-fg-muted",
      )}
    >
      {children}
    </span>
  );
}
