import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Toaster } from "sonner";
import { vi } from "vitest";

import { App } from "../App";

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

export interface Route {
  method?: string;
  path: string | RegExp;
  status?: number;
  body?: unknown;
  /** Dynamic reply — receives the parsed request so a POST can echo or fail. */
  reply?: (call: Call) => { status?: number; body?: unknown };
}

/**
 * A fetch stub instead of a mock-server dependency.
 *
 * The frontend talks to exactly one origin over one wrapper, so a route table
 * here is the whole API boundary a test needs.
 */
export function mockApi(routes: Route[]) {
  const calls: Call[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    const call: Call = { method, url, body };
    calls.push(call);

    const route = routes.find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        (typeof r.path === "string" ? r.path === url : r.path.test(url)),
    );
    if (!route) {
      return new Response(JSON.stringify({ detail: `no route: ${method} ${url}` }), {
        status: 501, headers: { "Content-Type": "application/json" },
      });
    }
    const out = route.reply ? route.reply(call) : { status: route.status, body: route.body };
    return new Response(JSON.stringify(out.body ?? null), {
      status: out.status ?? route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return calls;
}

export function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

/* ---------- fixtures, shaped exactly like the API's own rows ---------- */

export const ME = { id: 1, username: "tester", display_name: "테스터" };

export const AUTH_OK: Route = { path: "/api/auth/me", body: ME };
export const AUTH_401: Route = {
  path: "/api/auth/me", status: 401, body: { detail: "로그인이 필요합니다." },
};

export function meeting(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    title: "8월 3주차 개발 회의",
    original_filename: "weekly.m4a",
    stored_filename: "abc.m4a",
    duration: 1830,
    language: "ko",
    status: "COMPLETED",
    error_message: null,
    created_at: "2026-08-20T01:00:00+00:00",
    held_at: "2026-08-19T01:00:00+00:00",
    intelligence_state: "READY",
    intelligence_error: null,
    speaker_count: 2,
    ...over,
  };
}

export const SPEAKERS = [
  { id: 11, speaker_code: "SPEAKER_00", display_name: "화자 A" },
  { id: 12, speaker_code: "SPEAKER_01", display_name: "화자 B" },
];

export const SEGMENTS = [
  {
    sequence: 0, start_time: 0, end_time: 4, speaker_code: "SPEAKER_01",
    display_name: "화자 B",
    text: "현관 비밀번호 있으면 저한테 남겨주시면 감사하겠습니다.",
  },
  {
    sequence: 1, start_time: 5, end_time: 9, speaker_code: "SPEAKER_00",
    display_name: "화자 A",
    text: "아, 네. 통화 종료하고 바로 문자로 남겨드리겠습니다.",
  },
];

export const FACTS = [
  {
    id: 101, fact_type: "REQUEST", content: "현관 비밀번호를 남겨 달라는 요청",
    status: "UNKNOWN", deadline_text: null, deadline_at: null,
    start_time: 0, end_time: 4, source_segment_ids: [1],
    source_text: "[화자 B] 현관 비밀번호 있으면 저한테 남겨주시면 감사하겠습니다.",
    participants: { REQUESTER: "화자 B" },
  },
  {
    id: 102, fact_type: "ACTION_ITEM", content: "통화 종료 후 현관 비밀번호를 문자로 전달",
    status: "UNKNOWN", deadline_text: "통화 종료 후", deadline_at: null,
    start_time: 5, end_time: 9, source_segment_ids: [2],
    source_text: "[화자 A] 아, 네. 통화 종료하고 바로 문자로 남겨드리겠습니다.",
    participants: { ASSIGNEE: "화자 A" },
  },
  {
    id: 103, fact_type: "DECISION", content: "전달 수단은 문자로 한다",
    status: "DONE", deadline_text: null, deadline_at: null,
    start_time: 5, end_time: 9, source_segment_ids: [2],
    source_text: "[화자 A] 아, 네. 통화 종료하고 바로 문자로 남겨드리겠습니다.",
    participants: { DECIDER: "화자 A" },
  },
];

export const SOURCE_FACT = {
  index: 1, kind: "fact", meeting_id: 7, meeting_title: "8월 3주차 개발 회의",
  speakers: ["화자 A"], start_time: 5, end_time: 9, time_label: "00:05 ~ 00:09",
  text: "[화자 A] 아, 네. 통화 종료하고 바로 문자로 남겨드리겠습니다.",
  score: 0.31, fact_id: 102, fact_type: "ACTION_ITEM", fact_label: "할 일",
  summary: "통화 종료 후 현관 비밀번호를 문자로 전달", status: "UNKNOWN",
  status_label: "미확인(회의에서 완료 여부가 언급되지 않음)",
  deadline_text: "통화 종료 후", deadline_at: null,
  participants: { ASSIGNEE: "화자 A" },
  meeting_date: "2026-08-19", meeting_date_label: "2026-08-19",
  source_segment_ids: [2],
};
