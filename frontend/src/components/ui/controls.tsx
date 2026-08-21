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

/**
 * A real <label> wrapping its control, so clicking the text focuses the field.
 *
 * The hint sits outside the label on purpose: inside, it becomes part of the
 * field's accessible name, so a screen reader announces the whole sentence
 * instead of "회의 일시".
 */
export function Field({ label, hint, children, className, ...rest }: FieldProps) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label className="flex flex-col gap-1.5" {...rest}>
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        {children}
      </label>
      {hint ? <span className="text-xs text-fg-subtle">{hint}</span> : null}
    </div>
  );
}
