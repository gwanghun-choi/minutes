import clsx from "clsx";
import { useRef } from "react";

/**
 * One tab strip for the whole app.
 *
 * There were two hand-rolled copies of this — the list's 전체/내 회의/공유받은 회의
 * and the detail page's 개요/회의록/인사이트 — with the same markup, the same
 * classes, and the same missing keyboard behaviour. This is that markup once,
 * with arrow-key navigation and a roving tabindex, so the strip behaves the way
 * a tab strip is supposed to.
 *
 * Deliberately not Radix Tabs. Radix couples a trigger to a `Tabs.Content` and
 * generates `aria-controls` for every one of them; both of these strips drive a
 * *single* region whose contents are decided by the URL, so the other triggers
 * would carry `aria-controls` pointing at panels that do not exist. A dangling
 * ARIA reference is worse than the twenty lines below.
 */
export interface Tab<T extends string> {
  value: T;
  label: string;
  /** A quiet figure after the label — a count, never a second sentence. */
  badge?: number;
}

export function Tabs<T extends string>({
  label, value, tabs, onChange, className,
}: {
  label: string;
  value: T;
  tabs: readonly Tab<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  /** ← → moves between tabs and selects, which is what a tab strip does. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = tabs.findIndex((t) => t.value === value);
    const next = tabs[(at + step + tabs.length) % tabs.length]!;
    onChange(next.value);
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.value}"]`)?.focus();
  };

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={clsx("flex gap-0.5 border-b border-border", className)}
    >
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            type="button"
            data-tab={t.value}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={clsx(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2",
              "text-[13px] font-medium transition-colors",
              active
                ? "border-fg text-fg"
                : "border-transparent text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {t.label}
            {t.badge === undefined ? null : (
              <span
                className={clsx(
                  "rounded-full px-1.5 text-[11px] tabular-nums",
                  active ? "bg-surface-sunken text-fg-muted" : "text-fg-subtle",
                )}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
