import clsx from "clsx";
import type {
  InputHTMLAttributes, LabelHTMLAttributes, ReactNode,
  SelectHTMLAttributes, TextareaHTMLAttributes,
} from "react";

const FIELD =
  "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg " +
  "placeholder:text-fg-subtle disabled:bg-surface-muted disabled:text-fg-muted";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(FIELD, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(FIELD, "resize-y", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx(FIELD, "cursor-pointer", className)} {...rest} />;
}

interface FieldProps extends LabelHTMLAttributes<HTMLLabelElement> {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

/** A real <label> wrapping its control, so clicking the text focuses the field. */
export function Field({ label, hint, children, className, ...rest }: FieldProps) {
  return (
    <label className={clsx("flex flex-col gap-1.5", className)} {...rest}>
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint ? <span className="text-xs text-fg-subtle">{hint}</span> : null}
    </label>
  );
}
