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

/**
 * What this account may do with a meeting. Two values, no matrix: the server
 * computes it and the browser only decides what to draw with it — every refusal
 * is enforced again in `app/services/access.py`.
 */
export type MeetingRole = "OWNER" | "SHARED_READ";

/** Where an invitation got to. REVOKED is the owner taking it back. */
export type ShareStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "REVOKED";

/** A revision of a meeting's minutes. At most one PUBLISHED, at most one open. */
export type VersionStatus = "DRAFT" | "INDEXING" | "PUBLISHED" | "SUPERSEDED";

export interface User {
  id: number;
  username: string;
  display_name: string;
}

/**
 * One node of *this account's* category tree.
 *
 * A category is personal (migration 011): it is how one person arranged their
 * own screen, never a property of a meeting, and no other account can see it.
 * A meeting is still filed in at most one of them, and the tree changes what a
 * *filter* reaches rather than what an assignment means.
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
  /** My meetings here that I can still read. Not a count of everybody's. */
  meeting_count: number;
  /** My conversations filed here. */
  chat_count: number;
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
  /**
   * My filing of this meeting, joined per request. Another account reading the
   * same meeting gets its own values here, and the owner never sees mine.
   */
  category_id: number | null;
  category_name: string | null;
  /** What I call it — null means the canonical `title`. */
  alias: string | null;
  /** `alias ?? title`. What every screen shows; `title` stays the recording's. */
  display_title: string;
  intelligence_state: IntelligenceState;
  intelligence_error: string | null;
  /** The account that uploaded it. Null only for a pre-ownership orphan. */
  owner_user_id: number | null;
  owner_display_name: string | null;
  /** The revision the application shows and searches. Null before approval. */
  active_version: number | null;
  version_published_at: string | null;
}

export interface MeetingListRow extends Meeting {
  speaker_count: number;
  category_parent_id: number | null;
  /** Computed per request, so a row cannot be drawn with somebody else's rights. */
  is_owner: boolean;
  /** held_at when it is known, created_at otherwise. What the list sorts on. */
  occurred_at: string;
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
  /** The segments of `version`, not of every revision. */
  segments: TranscriptSegment[];
  /** Which diarized speaker the logged-in user is, or null. */
  my_speaker_id: number | null;
  role: MeetingRole;
  /** The revision these segments came from. */
  version: number;
  active_version: number | null;
  /**
   * The revision still open for correction — version 1 of a meeting waiting at
   * the review gate, and null for every approved meeting, because approved
   * minutes are immutable. Always null for a shared reader.
   */
  draft_version: number | null;
  /** How many accounts have accepted a share. Null for a shared reader. */
  shared_with: number | null;
}

export interface MeetingVersion {
  version: number;
  status: VersionStatus;
  created_at: string;
  published_at: string | null;
  created_by: string | null;
  segment_count: number;
}

export interface VersionList {
  versions: MeetingVersion[];
  active_version: number | null;
}

/** One row of the owner's sharing panel. */
export interface MeetingShare {
  id: number;
  invited_user_id: number;
  status: ShareStatus;
  created_at: string;
  responded_at: string | null;
  revoked_at: string | null;
  username: string;
  display_name: string;
}

/** One row of the invitation inbox — what somebody has offered me. */
export interface ShareInvitation {
  id: number;
  meeting_id: number;
  created_at: string;
  meeting_title: string;
  occurred_at: string;
  held_at_known: boolean;
  shared_by: string;
}

/** A person to invite. The picker searches names; what it sends is `id`. */
export interface UserSummary {
  id: number;
  username: string;
  display_name: string;
  /** Where this account already stands on the meeting being shared, if any. */
  share_status: ShareStatus | null;
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
  /** Empty means every meeting this account may read. */
  scope_meeting_ids: number[];
  /** Which of my categories I filed this conversation in. Same tree as meetings. */
  category_id: number | null;
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
  /** Which revision of the minutes these words are from. */
  meeting_version?: number | null;
  /**
   * The evidence was retrieved while this account could read the meeting, and it
   * no longer can. The citation stays so the answer still reads; the excerpt,
   * the meeting, and the link to it are gone.
   */
  revoked?: boolean;
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
