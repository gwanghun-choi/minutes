import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover border-transparent",
  secondary: "bg-surface text-fg hover:bg-surface-muted border-border-strong",
  ghost: "bg-transparent text-fg-muted hover:bg-surface-muted hover:text-fg border-transparent",
  danger: "bg-surface text-danger hover:bg-danger-soft border-danger/30",
  success: "bg-success text-white hover:bg-success/90 border-transparent",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant | undefined;
  size?: Size | undefined;
  loading?: boolean | undefined;
  icon?: ReactNode | undefined;
}

export function Button({
  variant = "secondary", size = "md", loading = false, icon, className,
  children, disabled, type = "button", ...rest
}: Props) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "inline-flex items-center justify-center rounded-md border font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant], SIZES[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}
