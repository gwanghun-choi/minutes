import type { FactStatus, FactType, IntelligenceState, MeetingStatus, ParticipantRole } from "../api/types";

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
