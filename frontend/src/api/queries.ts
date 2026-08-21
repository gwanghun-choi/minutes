import {
  useMutation, useQuery, useQueryClient, type UseQueryResult,
} from "@tanstack/react-query";

import { api, upload } from "./client";
import type {
  AskResult, ChatSession, ChatSessionDetail, Correction, Intelligence, Meeting,
  MeetingDetail, MeetingListRow, MeetingSummary, Speaker, User,
} from "./types";
import { SETTLED } from "../lib/labels";

/* Polling intervals. Kept together because they are a scale decision, not a
   per-component detail: a list that is mostly idle, a detail page watching a
   pipeline, and one panel waiting on a background extraction. */
const POLL_LIST = 3000;
const POLL_MEETING = 2000;
const POLL_INTEL = 3000;

export const keys = {
  me: ["me"] as const,
  meetings: ["meetings"] as const,
  meeting: (id: number) => ["meeting", id] as const,
  summary: (id: number) => ["summary", id] as const,
  intelligence: (id: number) => ["intelligence", id] as const,
  chatSessions: ["chat", "sessions"] as const,
  chatSession: (id: number) => ["chat", "session", id] as const,
};

/* ---------- auth ---------- */

/** The session lives on the server. A 401 here is "not logged in", not an error. */
export function useMe(): UseQueryResult<User | null> {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<User | null>("/api/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      api.post<{ username: string; display_name: string }>("/api/auth/login", body),
    // /api/auth/me is the single shape for "who am I"; the login response is
    // only an acknowledgement, so refetch rather than assemble a user here.
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/auth/logout"),
    // Everything cached belonged to the account that just left.
    onSettled: () => qc.clear(),
  });
}

/* ---------- meetings ---------- */

export function useMeetings() {
  return useQuery({
    queryKey: keys.meetings,
    queryFn: () => api.get<MeetingListRow[]>("/api/meetings"),
    refetchInterval: POLL_LIST,
  });
}

export function useMeeting(id: number) {
  return useQuery({
    queryKey: keys.meeting(id),
    queryFn: () => api.get<MeetingDetail>(`/api/meetings/${id}`),
    // Stop polling once no background task can change anything.
    refetchInterval: (q) =>
      q.state.data && SETTLED.includes(q.state.data.meeting.status) ? false : POLL_MEETING,
  });
}

export function useUploadMeeting(onProgress: (percent: number) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => upload<Meeting>("/api/meetings", form, onProgress),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meetings }),
  });
}

export function useDeleteMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<{ deleted: boolean }>(`/api/meetings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meetings }),
  });
}

export function useSetHeldAt(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (held_at: string | null) =>
      api.put<{ id: number; held_at: string | null }>(`/api/meetings/${id}/held-at`, { held_at }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.meeting(id) });
      void qc.invalidateQueries({ queryKey: keys.meetings });
    },
  });
}

export function useRenameSpeaker(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { speakerId: number; display_name: string }) =>
      api.patch<Speaker>(`/api/meetings/${id}/speakers/${v.speakerId}`, {
        display_name: v.display_name,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meeting(id) }),
  });
}

export function useSetMySpeaker(id: number) {
  const qc = useQueryClient();
  return useMutation({
    // null clears it. The server takes the user from the session, so the body
    // only ever names a speaker.
    mutationFn: (speaker_id: number | null) =>
      api.put<{ speaker_id: number | null }>(`/api/meetings/${id}/me`, { speaker_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meeting(id) }),
  });
}

export function useSaveTranscript(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (segments: { sequence: number; text: string; speaker_id: number | null }[]) =>
      api.patch<{ updated: number }>(`/api/meetings/${id}/transcript`, { segments }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meeting(id) }),
  });
}

export function useApprove(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ status: string }>(`/api/meetings/${id}/approve`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.meeting(id) });
      void qc.invalidateQueries({ queryKey: keys.meetings });
    },
  });
}

export function useReindex(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ status: string }>(`/api/meetings/${id}/reindex`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meeting(id) }),
  });
}

export function useCorrections(id: number) {
  return useMutation({
    mutationFn: () =>
      api.post<{ suggestions: Correction[] }>(`/api/meetings/${id}/corrections`),
  });
}

/* ---------- summary ---------- */

/** 404 until one is generated — that is a state, not a failure, so no retry. */
export function useSummary(id: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.summary(id),
    queryFn: () => api.get<MeetingSummary>(`/api/meetings/${id}/summary`),
    enabled,
    retry: false,
  });
}

export function useCreateSummary(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<MeetingSummary>(`/api/meetings/${id}/summary`),
    onSuccess: (row) => qc.setQueryData(keys.summary(id), row),
  });
}

/* ---------- meeting intelligence ---------- */

export function useIntelligence(id: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.intelligence(id),
    queryFn: () => api.get<Intelligence>(`/api/meetings/${id}/intelligence`),
    enabled,
    // Extraction runs in the background; the panel watches only while it does.
    refetchInterval: (q) => (q.state.data?.state === "BUILDING" ? POLL_INTEL : false),
  });
}

export function useRebuildIntelligence(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ state: string }>(`/api/meetings/${id}/intelligence/rebuild`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.intelligence(id) }),
  });
}

/* ---------- chat ---------- */

export function useChatSessions() {
  return useQuery({
    queryKey: keys.chatSessions,
    queryFn: () => api.get<ChatSession[]>("/api/chat/sessions"),
  });
}

export function useChatSession(id: number | null) {
  return useQuery({
    queryKey: keys.chatSession(id ?? 0),
    queryFn: () => api.get<ChatSessionDetail>(`/api/chat/sessions/${id}`),
    enabled: id != null,
  });
}

export function useCreateChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope_meeting_ids: number[]) =>
      api.post<ChatSession>("/api/chat/sessions", { scope_meeting_ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.chatSessions }),
  });
}

export function useDeleteChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<{ deleted: boolean }>(`/api/chat/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.chatSessions }),
  });
}

/**
 * Scope is persistent server state, so nothing local changes until the PATCH
 * succeeds. An optimistic update here was a real bug: the label said one thing
 * and the session searched another.
 */
export function useSetScope(sessionId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope_meeting_ids: number[]) =>
      api.patch<ChatSession>(`/api/chat/sessions/${sessionId}`, { scope_meeting_ids }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.chatSession(sessionId) }),
        qc.invalidateQueries({ queryKey: keys.chatSessions }),
      ]),
  });
}

export function useAsk(sessionId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { question: string; global_override?: boolean }) =>
      api.post<AskResult>(`/api/chat/sessions/${sessionId}/messages`, {
        question: v.question,
        global_override: !!v.global_override,
      }),
    // The persisted conversation is the truth; the frontend never assembles its
    // own history. Refetch the session and render what the server stored.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.chatSession(sessionId) });
      void qc.invalidateQueries({ queryKey: keys.chatSessions });
    },
  });
}
