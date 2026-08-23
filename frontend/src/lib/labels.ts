import type {
  FactStatus, FactType, IntelligenceState, MeetingStatus, ParticipantRole,
  ShareStatus, VersionStatus,
} from "../api/types";

/** Korean labels for every enum the API returns. One table per enum, used by
 *  every screen, so a status never reads differently in two places. */
export const MEETING_STATUS: Record<MeetingStatus, string> = {
  UPLOADED: "업로드됨",
  TRANSCRIBING: "음성 인식 중",
  DIARIZING: "화자 분리 중",
  REVIEW_REQUIRED: "검토 필요",
  INDEXING: "인덱싱 중",
  COMPLETED: "완료",
  FAILED: "실패",
};

/** A meeting in one of these is not being worked on by a background task. */
export const SETTLED: MeetingStatus[] = ["REVIEW_REQUIRED", "COMPLETED", "FAILED"];

/** Where an invitation stands, from the owner's side of the sharing panel. */
export const SHARE_STATUS: Record<ShareStatus, string> = {
  PENDING: "승인 대기",
  ACCEPTED: "공유 중",
  REJECTED: "거절함",
  REVOKED: "공유 해제됨",
};

/**
 * A revision's state. "현재 버전" rather than "게시됨" because that is the only
 * thing a reader needs from it: this is the one being shown and searched.
 */
export const VERSION_STATUS: Record<VersionStatus, string> = {
  DRAFT: "수정 중",
  INDEXING: "인덱싱 중",
  PUBLISHED: "현재 버전",
  SUPERSEDED: "이전 버전",
};

export const INTEL_STATE: Record<IntelligenceState, string> = {
  NOT_BUILT: "생성 안 됨",
  BUILDING: "생성 중",
  READY: "준비됨",
  FAILED: "실패",
};

export const FACT_TYPE: Record<FactType, string> = {
  REQUEST: "요청",
  DECISION: "결정",
  ACTION_ITEM: "할 일",
};

export const ROLE: Record<ParticipantRole, string> = {
  REQUESTER: "요청자",
  ASSIGNEE: "담당자",
  DECIDER: "결정자",
};

/**
 * Two answers the backend produces itself rather than generating: the corpus had
 * nothing, or this account is not mapped to a speaker (`rag.NO_ANSWER`,
 * `rag.NO_IDENTITY`). They are guidance about the search, not a finding from a
 * meeting, so the chat renders them as a notice instead of as prose with
 * evidence under it.
 */
const NOTICE_PREFIXES = [
  "회의록에서 해당 내용을 찾지 못했습니다.",
  "질문하신 분이 회의에서 어느 화자인지",
];

export const isNoticeAnswer = (content: string): boolean =>
  NOTICE_PREFIXES.some((p) => content.trimStart().startsWith(p));

/**
 * UNKNOWN is not "open". The meeting simply never said whether it was done, and
 * the panel has to show that rather than let a reader take it as outstanding.
 */
export const FACT_STATUS: Record<FactStatus, string> = {
  UNKNOWN: "상태 미확인",
  OPEN: "진행 중",
  DONE: "완료",
  CANCELLED: "취소",
  DEFERRED: "연기",
};
