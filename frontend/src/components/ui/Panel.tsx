import clsx from "clsx";
import type { ReactNode } from "react";

interface Props {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

/** A bordered surface with an optional header row. Not every block is a card —
 *  this is for the ones that genuinely group a titled section. */
export function Panel({
  title, description, actions, className, bodyClassName, children,
}: Props) {
  return (
    <section
      className={clsx("rounded-md border border-border bg-surface", className)}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-sm font-semibold text-fg">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      )}
      {/* Replaces the default padding rather than appending: `p-0` after
          `px-4 py-3.5` loses, because Tailwind emits the shorthand first. */}
      <div className={bodyClassName ?? "px-4 py-3.5"}>{children}</div>
    </section>
  );
}
