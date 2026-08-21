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

/** Sidebar grouping for the chat list: 오늘 / 이전 7일 / 이전. */
export function ageBucket(iso: string): string {
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return days < 1 ? "오늘" : days < 7 ? "이전 7일" : "이전";
}
