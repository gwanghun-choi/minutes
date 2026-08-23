/** mm:ss for a transcript offset in seconds. */
export function fmtTime(sec: number | null | undefined): string {
  if (sec == null) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const DATE = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric", month: "2-digit", day: "2-digit",
});
export function fmtDate(iso: string | null | undefined): string {
  return iso ? DATE.format(new Date(iso)) : "-";
}

/**
 * A TIMESTAMPTZ into what `<input type="datetime-local">` accepts, in the
 * browser's own timezone. `toISOString()` is UTC, so shift before slicing.
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** The inverse: a datetime-local value back into a TIMESTAMPTZ the API accepts. */
export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Now, in the browser's own timezone, ready for a `datetime-local` input.
 *
 * The upload form proposes this as the meeting date. It is a proposal the user
 * can change before sending; the server never derives a meeting date from when
 * the file arrived.
 */
export const nowLocalInput = (): string => toLocalInput(new Date().toISOString());

/** Beyond this the sidebar shows `99+` instead of the figure. */
export const COUNT_MAX = 99;

/**
 * A navigation count, as it is drawn beside a sidebar row.
 *
 * Past 99 the exact figure has stopped being something read at a glance and
 * started being something that pushes a folder name out of a narrow column, so
 * the label becomes `99+`. Only the *label* is capped — the count itself stays
 * whatever the server counted, in the cache, in the row's title, and in every
 * request that follows.
 */
export function countLabel(n: number): string {
  return n > COUNT_MAX ? `${COUNT_MAX}+` : String(n);
}
