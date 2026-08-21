import type { MeetingListRow } from "../api/types";

/**
 * The one place a meeting list is narrowed.
 *
 * The meeting list and the chat scope dialog ask the same four questions of the
 * same rows; two copies of this predicate would drift the moment one gained a
 * field. Filtering happens in the browser on purpose: `GET /api/meetings`
 * already returns every row and is polled anyway, so a query parameter would
 * add a server round trip per keystroke without removing anything.
 *
 * ponytail: client-side filter over the full list. Fine while the list is one
 * request; revisit when /api/meetings needs pagination.
 */
export interface MeetingQuery {
  /** Matches the title or the original filename, case-insensitively. */
  text: string;
  /** "" = every category, "none" = 미분류 only, otherwise a category id. */
  category: string;
  /** "" = every status, otherwise a MeetingStatus. */
  status: string;
  /** Epoch ms; a meeting older than this is excluded. Null = no limit. */
  cutoff: number | null;
}

export const EMPTY_QUERY: MeetingQuery = { text: "", category: "", status: "", cutoff: null };

export const RANGES = [
  { days: 0, label: "전체 기간" },
  { days: 7, label: "최근 7일" },
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 90일" },
];

/**
 * When the meeting happened, for ordering and range filters.
 *
 * `held_at` if it is known, `created_at` only as a fallback so a legacy meeting
 * still sorts deterministically. Every screen that *renders* this date has to
 * say which one it used — see `MeetingDate`.
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
  if (q.category === "none" ? m.category_id !== null : q.category && String(m.category_id) !== q.category) {
    return false;
  }
  if (q.status && m.status !== q.status) return false;
  if (q.cutoff !== null && meetingTime(m) < q.cutoff) return false;
  return true;
}

export const isFiltered = (q: MeetingQuery): boolean =>
  q.text.trim() !== "" || q.category !== "" || q.status !== "" || q.cutoff !== null;
