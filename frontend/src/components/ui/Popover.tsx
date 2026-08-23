import * as RadixPopover from "@radix-ui/react-popover";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * An anchored panel, for something that belongs to the control that opened it.
 *
 * A dialog takes over the screen and asks to be finished; a popover stays
 * attached to its trigger and can be dismissed by looking away. The invitation
 * inbox is the second kind — it arrives while you are doing something else and
 * answering it should not close what you were reading.
 *
 * Radix owns the hard parts: collision-aware positioning, focus moving in and
 * back out again, Escape, outside click, and `aria-expanded` on the trigger.
 * `modal` is deliberately off — the page behind stays scrollable and readable,
 * which is the whole difference from `Dialog`.
 */
export function Popover({
  trigger, title, children, align = "end", className, open, onOpenChange,
}: {
  trigger: ReactNode;
  /** Names the panel for a screen reader; also rendered as its heading. */
  title: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
  /** Omit both to let Radix own the open state, which is the usual case. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RadixPopover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label={title}
          className={clsx(
            "z-50 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg",
            "border border-border bg-surface shadow-pop",
            className,
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
            <h2 className="text-section">{title}</h2>
          </div>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
