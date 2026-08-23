import {
  useMutation, useQuery, useQueryClient, type UseQueryResult,
} from "@tanstack/react-query";

import { api, upload } from "./client";
import type {
  AskResult, CategoryTree, ChatSession, ChatSessionDetail, Correction, Intelligence,
  Meeting, MeetingCategory, MeetingDetail, MeetingPage, MeetingShare, MeetingSummary,
  ShareInvitation, Speaker, User, UserSummary, VersionList,
} from "./types";
import { SETTLED } from "../lib/labels";

/* Polling intervals. Kept together because they are a scale decision, not a
   per-component detail: a list that is mostly idle, a detail page watching a
   pipeline, and one panel waiting on a background extraction. */
const POLL_LIST = 3000;
const POLL_MEETING = 2000;
const POLL_INTEL = 3000;
/* The invitation badge sits in the sidebar on every screen, so it is checked at
   the same cadence as the list rather than on its own faster clock. */
const POLL_INVITATIONS = 30_000;

export const keys = {
  me: ["me"] as const,
  meetings: ["meetings"] as const,
  categories: ["meeting-categories"] as const,
  meeting: (id: number) => ["meeting", id] as const,
  shares: (id: number) => ["shares", id] as const,
  versions: (id: number) => ["versions", id] as const,
  invitations: ["share-invitations"] as const,
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

/**
 * One page of meetings, narrowed by the server.
 *
 * The parameters go into the query key, so every filter and page is its own
 * cache entry, and `placeholderData` keeps the page that is on screen visible
 * while the next one loads — a paginated table that blanks out on every click
 * reads as a failure.
 *
 * Invalidation still targets `keys.meetings`, which is the prefix of every one
 * of these keys, so an upload or a delete refreshes whatever page is open.
 */
export function useMeetings(params: Record<string, string | number> = {}) {
  const search = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    queryKey: [...keys.meetings, search],
    queryFn: () => api.get<MeetingPage>(`/api/meetings${search ? `?${search}` : ""}`),
    refetchInterval: POLL_LIST,
    placeholderData: (previous) => previous,
  });
}

/**
 * One meeting, optionally at a named revision.
 *
 * The version goes into the query key, so the published minutes and an open
 * draft are two cache entries and switching between them cannot show one
 * labelled as the other. Omitting it asks the server for the revision that
 * matters to this account — the draft an owner is editing, the published one for
 * everybody else.
 */
export function useMeeting(id: number, version?: number) {
  return useQuery({
    queryKey: [...keys.meeting(id), version ?? null],
    queryFn: () =>
      api.get<MeetingDetail>(
        `/api/meetings/${id}${version ? `?version=${version}` : ""}`,
      ),
    // Stop polling once no background task can change anything.
    refetchInterval: (q) =>
      q.state.data && SETTLED.includes(q.state.data.meeting.status) ? false : POLL_MEETING,
  });
}

/* Both of these change how many meetings exist for this account, so both
   refresh the sidebar's counts as well as the list. `keys.categories` is where
   전체 회의 and 미분류 live now — a number left behind by a delete is worse than
   no number, because it looks like a page that has not finished loading. */
export function useUploadMeeting(onProgress: (percent: number) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => upload<Meeting>("/api/meetings", form, onProgress),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.meetings });
      void qc.invalidateQueries({ queryKey: keys.categories });
    },
  });
}

/** The two ways a meeting leaves my screen. Both change how many I can read,
 *  so both refresh the list and the counts beside the navigation rows. */
function useForget() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.meetings });
    void qc.invalidateQueries({ queryKey: keys.categories });
  };
}

/** The owner's 삭제: the meeting, its audio, its minutes and everybody's access. */
export function useDeleteMeeting() {
  const settle = useForget();
  return useMutation({
    mutationFn: (id: number) => api.del<{ deleted: boolean }>(`/api/meetings/${id}`),
    onSuccess: settle,
  });
}

/**
 * A shared reader's 삭제: my own access, and nothing else.
 *
 * A different endpoint because it is a different act — the canonical DELETE is
 * refused for this account either way, and calling it would be asking to remove
 * somebody else's recording. What goes is the ACCEPTED share row that let me
 * read it, so the meeting drops out of my list, my sidebar, my counts and my
 * retrieval scope, and out of nobody else's.
 */
export function useLeaveSharedMeeting() {
  const settle = useForget();
  return useMutation({
    mutationFn: (id: number) => api.del<{ left: boolean }>(`/api/meetings/${id}/shares/me`),
    onSuccess: settle,
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

/* ---------- meeting categories ---------- */

/**
 * The sidebar's whole navigation: the tree, plus 전체 회의 and 미분류.
 *
 * Small and shared by the filter bar, the scope dialog, and the detail page, so
 * it is cached rather than polled. The two fixed counts ride along with the
 * tree rather than being two more list requests — one aggregate on the server,
 * one entry in the cache, and one thing to invalidate when a filing moves.
 */
export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: () => api.get<CategoryTree>("/api/meeting-categories"),
    staleTime: 30_000,
  });
}

/**
 * One hook for all four category mutations.
 *
 * They differ only in the request and share the same invalidation — a rename or
 * a delete changes what every meeting row displays, so both lists refetch.
 * Splitting this into four near-identical hooks would say nothing extra.
 */
export function useCategoryMutations() {
  const qc = useQueryClient();
  const settle = () => {
    void qc.invalidateQueries({ queryKey: keys.categories });
    void qc.invalidateQueries({ queryKey: keys.meetings });
  };
  const create = useMutation({
    mutationFn: (v: { name: string; parent_id?: number | null }) =>
      api.post<MeetingCategory>("/api/meeting-categories", {
        name: v.name,
        parent_id: v.parent_id ?? null,
      }),
    onSuccess: settle,
  });
  // Moving a category moves no meeting: they keep the category_id they had, and
  // what changes is which parent filter reaches them. Both lists still refetch,
  // because the rendered path changed.
  const move = useMutation({
    mutationFn: (v: { id: number; parent_id: number | null }) =>
      api.put<MeetingCategory>(`/api/meeting-categories/${v.id}/parent`, {
        parent_id: v.parent_id,
      }),
    onSuccess: settle,
  });
  const rename = useMutation({
    mutationFn: (v: { id: number; name: string }) =>
      api.patch<MeetingCategory>(`/api/meeting-categories/${v.id}`, { name: v.name }),
    onSuccess: settle,
  });
  const remove = useMutation({
    // The meetings keep existing with category_id back to NULL — the FK does
    // that, so nothing here touches a meeting.
    mutationFn: (id: number) =>
      api.del<{ deleted: boolean }>(`/api/meeting-categories/${id}`),
    onSuccess: settle,
  });
  return { create, rename, move, remove };
}

/**
 * My filing of this meeting, and my name for it.
 *
 * Both write `user_meeting_filing` and neither touches the meeting, so a shared
 * reader may use them — arranging your own list is not editing somebody's
 * minutes. Both invalidate the same three caches: the row, the list, and the
 * counts beside the categories.
 */
function useFiling(id: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.meeting(id) });
    void qc.invalidateQueries({ queryKey: keys.meetings });
    void qc.invalidateQueries({ queryKey: keys.categories });
  };
}

export function useSetMeetingCategory(id: number) {
  const settle = useFiling(id);
  return useMutation({
    // null clears it back to 미분류.
    mutationFn: (category_id: number | null) =>
      api.put<{ id: number; category_id: number | null; category_name: string | null }>(
        `/api/meetings/${id}/category`,
        { category_id },
      ),
    onSuccess: settle,
  });
}

export function useSetMeetingAlias(id: number) {
  const settle = useFiling(id);
  return useMutation({
    // "" or null goes back to the meeting's own title rather than storing a copy.
    mutationFn: (alias: string | null) =>
      api.put<{ id: number; alias: string | null; display_title: string }>(
        `/api/meetings/${id}/alias`,
        { alias },
      ),
    onSuccess: settle,
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

/* ---------- sharing ---------- */

/** The owner's sharing panel. 403 for anybody else, so it is only ever enabled
 *  where the server already said this account is the owner. */
export function useShares(id: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.shares(id),
    queryFn: () => api.get<MeetingShare[]>(`/api/meetings/${id}/shares`),
    enabled,
  });
}

/** Accounts matching a search term. Disabled on an empty term: this endpoint
 *  answers searches, and browsing the whole directory is not one. */
export function useUserSearch(term: string, meetingId: number) {
  const q = term.trim();
  return useQuery({
    queryKey: ["users", meetingId, q],
    queryFn: () =>
      api.get<UserSummary[]>(
        `/api/users?q=${encodeURIComponent(q)}&meeting_id=${meetingId}`,
      ),
    enabled: q.length > 0,
  });
}

/**
 * Invite and revoke, together: they are the two directions of one panel and
 * share an invalidation. Revoking also changes what the invited account may
 * read, but that is their cache, not this one.
 */
export function useShareMutations(id: number) {
  const qc = useQueryClient();
  const settle = () => {
    void qc.invalidateQueries({ queryKey: keys.shares(id) });
    void qc.invalidateQueries({ queryKey: keys.meeting(id) });
  };
  const invite = useMutation({
    mutationFn: (user_id: number) =>
      api.post<MeetingShare>(`/api/meetings/${id}/shares`, { user_id }),
    onSuccess: settle,
  });
  const revoke = useMutation({
    mutationFn: (user_id: number) =>
      api.del<MeetingShare>(`/api/meetings/${id}/shares/${user_id}`),
    onSuccess: settle,
  });
  return { invite, revoke };
}

/** What has been offered to me. Polled because it arrives from another account. */
export function useInvitations() {
  return useQuery({
    queryKey: keys.invitations,
    queryFn: () => api.get<ShareInvitation[]>("/api/share-invitations"),
    refetchInterval: POLL_INVITATIONS,
  });
}

export function useRespondToInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; accept: boolean }) =>
      api.post<{ meeting_id: number; status: string }>(
        `/api/share-invitations/${v.id}/${v.accept ? "accept" : "reject"}`,
      ),
    // Accepting adds a meeting to the list; refusing removes an inbox row.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.invitations });
      void qc.invalidateQueries({ queryKey: keys.meetings });
      void qc.invalidateQueries({ queryKey: keys.categories });
    },
  });
}

/** The revision history, read-only. Provenance for a database that once held a
 *  second revision — approved minutes are immutable, so nothing writes here. */
export function useVersions(id: number, enabled = true) {
  return useQuery({
    queryKey: keys.versions(id),
    queryFn: () => api.get<VersionList>(`/api/meetings/${id}/versions`),
    enabled,
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
      // Approving is what publishes the minutes, so the history changed too.
      void qc.invalidateQueries({ queryKey: keys.versions(id) });
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
 * A conversation's name is server state like any other: the sidebar row and the
 * chat header both read the same refetched value, so they cannot disagree.
 */
export function useRenameChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; title: string }) =>
      api.patch<ChatSession>(`/api/chat/sessions/${v.id}/title`, { title: v.title }),
    onSuccess: (_row, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.chatSessions }),
        qc.invalidateQueries({ queryKey: keys.chatSession(v.id) }),
      ]),
  });
}

/**
 * Scope is persistent server state, so nothing local changes until the PATCH
 * succeeds. An optimistic update here was a real bug: the label said one thing
 * and the session searched another.
 */
/** File a conversation in one of my categories, or take it out of one. The same
 *  tree meetings use — one vocabulary for arranging one person's work. */
export function useSetChatCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; category_id: number | null }) =>
      api.patch<ChatSession>(`/api/chat/sessions/${v.id}/category`, {
        category_id: v.category_id,
      }),
    onSuccess: (_row, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.chatSessions }),
        qc.invalidateQueries({ queryKey: keys.chatSession(v.id) }),
        qc.invalidateQueries({ queryKey: keys.categories }),
      ]),
  });
}

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
