import * as RadixDialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./Button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * Every dialog in the app is this one.
 *
 * Radix owns focus trapping, ESC, the backdrop click, `aria-modal`, and
 * returning focus on close — there is no second close path to drift out of sync
 * with the first, and no `hidden` attribute fighting an author `display` rule.
 */
export function Dialog({
  open, onOpenChange, title, description, footer, className, children,
}: Props) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-fg/40" />
        <RadixDialog.Content
          className={clsx(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(32rem,calc(100vw-2rem))]",
            "-translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-border",
            "bg-surface p-5 shadow-xl",
            className,
          )}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-base font-semibold text-fg">
                {title}
              </RadixDialog.Title>
              <RadixDialog.Description
                className={clsx("mt-1 text-xs text-fg-muted", !description && "sr-only")}
              >
                {description ?? title}
              </RadixDialog.Description>
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="닫기" icon={<X className="size-4" />} />
            </RadixDialog.Close>
          </div>
          {children}
          {footer ? <div className="flex items-center gap-2">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  /** The action is not available right now, and the body says why. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

/** The one confirmation surface, replacing window.confirm(). */
export function ConfirmDialog({
  open, onOpenChange, title, body, confirmLabel, destructive, loading,
  confirmDisabled, onConfirm,
}: ConfirmProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      className="w-[min(28rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            size="sm"
            variant={destructive ? "danger" : "primary"}
            loading={loading}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-fg-muted">{body}</div>
    </Dialog>
  );
}
