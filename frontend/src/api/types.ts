/**
 * The API boundary, typed by hand.
 *
 * Four tables and about twenty endpoints do not need generated clients — these
 * shapes mirror what `app/api/*` actually returns and are the only place the
 * frontend describes the server.
 */

export type MeetingStatus =
  | "UPLOADED" | "TRANSCRIBING" | "DIARIZING" | "REVIEW_REQUIRED"
  | "INDEXING" | "COMPLETED" | "FAILED";

export type IntelligenceState = "NOT_BUILT" | "BUILDING" | "READY" | "FAILED";
export type FactType = "REQUEST" | "DECISION" | "ACTION_ITEM";
export type FactStatus = "UNKNOWN" | "OPEN" | "DONE" | "CANCELLED" | "DEFERRED";
export type ParticipantRole = "REQUESTER" | "ASSIGNEE" | "DECIDER";

export interface User {
  id: number;
  username: string;
  display_name: string;
}

/**
 * One node of the category tree. Null on a meeting still means 미분류, and a
 * meeting still carries exactly one category — the tree changes what a *filter*
 * reaches, never what an assignment means.
 */
export interface MeetingCategory {
  id: number;
  name: string;
  /** null = a root category. */
  parent_id: number | null;
  /** "업무 / 개발", built by the server so every screen renders the same path. */
  path: string;
  /** 0 for a root. Used for indentation only. */
  depth: number;
  /** How many meetings would become 미분류 if this were deleted. */
  meeting_count: number;
  /** Why a delete may be refused: a parent never takes its children. */
  child_count: number;
}

export interface Meeting {
  id: number;
  title: string;
  original_filename: string;
  stored_filename: string;
  duration: number | null;
  language: string | null;
  status: MeetingStatus;
  error_message: string | null;
  /** When the file was uploaded. Never presented as when the meeting happened. */
  created_at: string;
  /** When the meeting actually took place. Null on every legacy meeting. */
  held_at: string | null;
  category_id: number | null;
  /** Resolved by the server so no screen has to join the category list itself. */
  category_name: string | null;
  intelligence_state: IntelligenceState;
  intelligence_error: string | null;
}

export interface MeetingListRow extends Meeting {
  speaker_count: number;
  /** held_at when it is known, created_at otherwise. What the list sorts on. */
  occurred_at: string;
  category_parent_id: number | null;
}

/** One page of meetings. `total` is what the filter matched, not what arrived. */
export interface MeetingPage {
  items: MeetingListRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface Speaker {
  id: number;
  speaker_code: string;
  display_name: string | null;
}

export interface TranscriptSegment {
  sequence: number;
  start_time: number;
  end_time: number;
  text: string;
  speaker_code: string | null;
  display_name: string | null;
}

export interface MeetingDetail {
  meeting: Meeting;
  speakers: Speaker[];
  segments: TranscriptSegment[];
  /** Which diarized speaker the logged-in user is, or null. */
  my_speaker_id: number | null;
}

export interface MeetingSummary {
  meeting_id: number;
  content: string;
  created_at?: string;
  updated_at?: string;
}

export interface Correction {
  sequence: number;
  before: string;
  after: string;
}

export interface MeetingFact {
  id: number;
  fact_type: FactType;
  content: string;
  status: FactStatus;
  /** What the meeting actually said, always kept even when no date resolved. */
  deadline_text: string | null;
  deadline_at: string | null;
  start_time: number;
  end_time: number;
  source_segment_ids: number[];
  /** The utterances the claim rests on. A fact without them is not stored. */
  source_text: string;
  participants: Partial<Record<ParticipantRole, string>>;
}

export interface Intelligence {
  state: IntelligenceState;
  error: string | null;
  facts: MeetingFact[];
}

export interface ChatSession {
  id: number;
  title: string;
  /** Empty means the whole corpus. */
  scope_meeting_ids: number[];
  updated_at: string;
}

export interface RagSource {
  index: number;
  kind: "fact" | "chunk";
  meeting_id: number;
  meeting_title: string;
  speakers: string[];
  start_time: number;
  end_time: number;
  time_label: string;
  text: string;
  score: number;
  chunk_id?: number;
  fact_id?: number;
  fact_type?: FactType;
  fact_label?: string;
  summary?: string;
  status?: FactStatus;
  status_label?: string;
  deadline_text?: string | null;
  deadline_at?: string | null;
  participants?: Partial<Record<ParticipantRole, string>>;
  meeting_date?: string;
  meeting_date_label?: string;
  source_segment_ids?: number[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources: RagSource[];
}

export interface ChatSessionDetail {
  session: ChatSession;
  messages: ChatMessage[];
}

export interface AskResult {
  answer: string;
  sources: RagSource[];
  /** The chosen scope answered nothing. Widening it is the user's click. */
  scope_miss: boolean;
}
