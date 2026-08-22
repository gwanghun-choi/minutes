import type { MeetingCategory, MeetingListRow } from "../api/types";

/**
 * What "narrowed" means, in one place — now split by who does the narrowing.
 *
 * The meeting list is paginated, so it cannot filter what it has: a page is all
 * it has. `toParams` turns the query into the request the server answers, and
 * PostgreSQL does the narrowing (`app/api/meetings.py:_narrow`) — including the
 * one rule the browser could not implement at all, that a parent category also
 * means every category under it.
 *
 * `matches` stays for the chat scope dialog, which is a different job: it is a
 * picker over one already-fetched set of approved meetings, and it has to keep
 * showing a meeting that is already ticked while the text box narrows the rest.
 * Both read the same `MeetingQuery`, so the two screens still ask the same
 * questions of a meeting.
 */
export interface MeetingQuery {
  /** Matches the title or the original filename, case-insensitively. */
  text: string;
  /** "" = every category, "none" = 미분류 only, otherwise a category id.
   *  A category id includes every category under it. */
  category: string;
  /** "" = every status, otherwise a MeetingStatus. */
  status: string;
  /** How many days back, from the meeting date. 0 = no limit. */
  days: number;
}

export type MeetingSort = "held_desc" | "held_asc" | "created_desc";

export const EMPTY_QUERY: MeetingQuery = { text: "", category: "", status: "", days: 0 };

export const RANGES = [
  { days: 0, label: "전체 기간" },
  { days: 7, label: "최근 7일" },
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 90일" },
];

export const SORTS: { value: MeetingSort; label: string }[] = [
  { value: "held_desc", label: "회의 일시 최신순" },
  { value: "held_asc", label: "회의 일시 오래된순" },
  { value: "created_desc", label: "등록 최신순" },
];

/** The page sizes the list offers. 100 is `PAGE_SIZE_MAX` on the server. */
export const PAGE_SIZES = [20, 50, 100];

/**
 * When the meeting happened, for display.
 *
 * `held_at` if it is known, `created_at` only as a fallback. Every screen that
 * *renders* this date has to say which one it used — see `MeetingDate`.
 */
export function meetingTime(m: { held_at: string | null; created_at: string }): number {
  return new Date(m.held_at ?? m.created_at).getTime();
}

export function matches(m: MeetingListRow, q: MeetingQuery): boolean {
  const text = q.text.trim().toLowerCase();
  if (
    text &&
    !m.title.toLowerCase().includes(text) &&
    !m.original_filename.toLowerCase().includes(text)
  ) {
    return false;
  }
  if (
    q.category === "none"
      ? m.category_id !== null
      : q.category && String(m.category_id) !== q.category
  ) {
    return false;
  }
  if (q.status && m.status !== q.status) return false;
  if (q.days > 0 && meetingTime(m) < Date.now() - q.days * 86_400_000) return false;
  return true;
}

export const isFiltered = (q: MeetingQuery): boolean =>
  q.text.trim() !== "" || q.category !== "" || q.status !== "" || q.days > 0;

/** The query as request parameters. Empty values are left out entirely, so a
 *  default query is a bare `/api/meetings` and stays cacheable. */
export function toParams(q: MeetingQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.text.trim()) out.q = q.text.trim();
  if (q.category) out.category = q.category;
  if (q.status) out.status = q.status;
  if (q.days > 0) out.days = String(q.days);
  return out;
}

/** Label for a category id (or "none"), for a filter chip. */
export function categoryLabel(
  value: string, categories: MeetingCategory[] | undefined,
): string | undefined {
  if (value === "none") return "미분류";
  return categories?.find((k) => String(k.id) === value)?.path;
}
