import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The app's one contextual menu, for row actions that should not sit on the row.
 *
 * Radix owns what is genuinely hard here — `aria-haspopup`, arrow-key roving
 * focus, Escape, outside click, and returning focus to the trigger. A hand-rolled
 * popover would be more code and would get one of those wrong.
 */
export function Menu({
  label, children, className,
}: { label: string; children: ReactNode; className?: string }) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger
        aria-label={label}
        className={clsx(
          "inline-flex size-6 shrink-0 items-center justify-center rounded",
          "text-fg-subtle transition-colors hover:bg-border hover:text-fg",
          "data-[state=open]:bg-border data-[state=open]:text-fg",
          className,
        )}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-36 rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export function MenuItem({
  onSelect, icon, destructive, children,
}: {
  onSelect: () => void;
  icon?: ReactNode;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      className={clsx(
        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none",
        destructive
          ? "text-danger data-[highlighted]:bg-danger-soft"
          : "text-fg data-[highlighted]:bg-surface-muted",
      )}
    >
      {icon}
      {children}
    </RadixMenu.Item>
  );
}
