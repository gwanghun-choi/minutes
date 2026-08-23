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
  /** Hold the response open for this many ms, so a loading state can be seen. */
  delay?: number;
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

    const route = [...routes, ...SHELL_ROUTES].find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        (typeof r.path === "string" ? r.path === url : r.path.test(url)),
    );
    if (!route) {
      return new Response(JSON.stringify({ detail: `no route: ${method} ${url}` }), {
        status: 501, headers: { "Content-Type": "application/json" },
      });
    }
    if (route.delay) await new Promise((done) => setTimeout(done, route.delay));
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

/**
 * What the app shell asks for on every screen, appended after whatever a test
 * declares so an explicit route always wins.
 *
 * The invitation count sits in the sidebar navigation, so it is requested by
 * every rendered route. Making each test restate it would say nothing about
 * that test — and leaving it out turned every one of them into a 501.
 */
export const INVITATIONS: Route = { path: "/api/share-invitations", body: [] };
const SHELL_ROUTES: Route[] = [INVITATIONS];
export const AUTH_401: Route = {
  path: "/api/auth/me", status: 401, body: { detail: "로그인이 필요합니다." },
};

export function meeting(over: Partial<Record<string, unknown>> = {}) {
  const row = {
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
    category_id: 1,
    category_name: "개발",
    category_parent_id: null,
    intelligence_state: "READY",
    intelligence_error: null,
    speaker_count: 2,
    // Ownership, as every row now carries it. `is_owner` is computed per
    // request by the server, so a fixture states it rather than deriving it.
    owner_user_id: ME.id,
    owner_display_name: ME.display_name,
    is_owner: true,
    active_version: 1,
    version_published_at: "2026-08-20T02:00:00+00:00",
    ...over,
  };
  // The server derives it; every list row carries it.
  return { occurred_at: row.held_at ?? row.created_at, ...row };
}

type Row = ReturnType<typeof meeting>;

/** `GET /api/meetings` now carries a query string, so it is matched by shape. */
export const MEETINGS_PATH = /\/api\/meetings(\?|$)/;

/** The envelope the list endpoint returns. */
export function meetingPage(items: Row[], over: Record<string, unknown> = {}) {
  return { items, total: items.length, page: 1, page_size: 20, ...over };
}

/**
 * A stand-in for the list endpoint that actually reads its parameters.
 *
 * Narrowing and paging moved into SQL, so a fixed body could no longer tell a
 * request that filtered from one that did not. What the frontend is responsible
 * for is asking correctly and rendering the page it gets — which is what this
 * lets a test assert. The SQL itself is covered by `tests/test_meeting_list.py`.
 */
export function meetingsRoute(rows: Row[]): Route {
  return {
    path: MEETINGS_PATH,
    reply: (call) => {
      const p = new URL(call.url, "http://localhost").searchParams;
      const q = (p.get("q") ?? "").toLowerCase();
      const days = Number(p.get("days")) || 0;
      const category = p.get("category") ?? "";
      const status = p.get("status") ?? "";
      const size = Number(p.get("page_size")) || 20;
      const page = Number(p.get("page")) || 1;

      let items = rows.filter((m) => {
        if (q && !`${m.title} ${m.original_filename}`.toLowerCase().includes(q)) return false;
        if (status && m.status !== status) return false;
        if (category === "none" && m.category_id !== null) return false;
        if (category && category !== "none" && String(m.category_id) !== category) return false;
        if (days > 0 && new Date(m.occurred_at).getTime() < Date.now() - days * 86_400_000) {
          return false;
        }
        return true;
      });
      const order = p.get("sort") === "held_asc" ? 1 : -1;
      items = [...items].sort(
        (a, b) =>
          order * (new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()),
      );
      return {
        body: {
          items: items.slice((page - 1) * size, page * size),
          total: items.length,
          page,
          page_size: size,
        },
      };
    },
  };
}

/** A flat pair, as a tree of depth 0: `path` is the name for a root. */
export const CATEGORIES: Route = {
  path: "/api/meeting-categories",
  body: [
    { id: 1, name: "개발", parent_id: null, path: "개발", depth: 0, meeting_count: 1, child_count: 0 },
    { id: 2, name: "고객 미팅", parent_id: null, path: "고객 미팅", depth: 0, meeting_count: 0, child_count: 0 },
  ],
};

/** 업무 / (개발, 운영) plus a root 개인, in the path order the server returns. */
export const CATEGORY_TREE: Route = {
  path: "/api/meeting-categories",
  body: [
    { id: 1, name: "개인", parent_id: null, path: "개인", depth: 0, meeting_count: 0, child_count: 0 },
    { id: 2, name: "업무", parent_id: null, path: "업무", depth: 0, meeting_count: 1, child_count: 2 },
    { id: 3, name: "개발", parent_id: 2, path: "업무 / 개발", depth: 1, meeting_count: 2, child_count: 0 },
    { id: 4, name: "운영", parent_id: 2, path: "업무 / 운영", depth: 1, meeting_count: 0, child_count: 0 },
  ],
};

/**
 * The upload path is the one call that does not go through `fetch` — it needs
 * `upload.onprogress`, which only XMLHttpRequest has. This captures what was
 * actually sent.
 */
export function mockUpload(body: unknown = { id: 9, title: "새 회의" }) {
  const sent: FormData[] = [];
  class FakeXhr {
    upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
    status = 200;
    response = body;
    responseType = "";
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    open() {}
    send(form: FormData) {
      sent.push(form);
      this.onload?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return sent;
}

/**
 * `GET /api/meetings/{id}`, with the permission fields the server computes.
 *
 * `role` is the whole reason this is a helper: the detail page draws sharing,
 * revision, and delete controls from it, so a fixture that left it out would
 * silently test the shared-reader screen while claiming to test the owner's.
 */
export function meetingDetail(over: Record<string, unknown> = {}) {
  const {
    speakers, segments, my_speaker_id, role, version, active_version,
    draft_version, shared_with, ...meetingOver
  } = over as Record<string, never>;
  // A meeting at the review gate has published nothing and has version 1 open;
  // an approved one has published version 1 and nothing open. Derived rather
  // than restated at every call site, because the server derives it too and a
  // fixture that disagreed would test a state the API cannot produce.
  const review = meetingOver.status === "REVIEW_REQUIRED";
  const row = meeting({ active_version: review ? null : 1, ...meetingOver });
  return {
    meeting: row,
    speakers: speakers ?? SPEAKERS,
    segments: segments ?? SEGMENTS,
    my_speaker_id: my_speaker_id ?? 11,
    role: role ?? "OWNER",
    version: version ?? 1,
    active_version: active_version === undefined ? row.active_version : active_version,
    draft_version: draft_version === undefined ? (review ? 1 : null) : draft_version,
    shared_with: shared_with ?? 0,
  };
}

/** The version history panel's route, for a meeting that has never been revised. */
export function versionsRoute(id = 7, over: Record<string, unknown> = {}): Route {
  return {
    path: `/api/meetings/${id}/versions`,
    body: {
      active_version: 1,
      versions: [
        {
          version: 1, status: "PUBLISHED", created_at: "2026-08-20T01:00:00+00:00",
          published_at: "2026-08-20T02:00:00+00:00", created_by: ME.display_name,
          segment_count: 2,
        },
      ],
      ...over,
    },
  };
}

/** The owner's sharing panel, empty by default. */
export function sharesRoute(id = 7, body: unknown[] = []): Route {
  return { path: `/api/meetings/${id}/shares`, body };
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

/** Six sources, the shape `rag.answer` actually returns at Top-K over both
 *  layers. Used to pin that the UI shows two and keeps all six. */
export const SIX_SOURCES = Array.from({ length: 6 }, (_, i) => ({
  index: i + 1,
  kind: "chunk" as const,
  meeting_id: 7,
  meeting_title: "8월 3주차 개발 회의",
  speakers: ["화자 A"],
  start_time: i * 10,
  end_time: i * 10 + 9,
  time_label: `00:${String(i * 10).padStart(2, "0")} ~ 00:${String(i * 10 + 9).padStart(2, "0")}`,
  text: `근거 본문 ${i + 1}번입니다.`,
  score: 0.5 - i * 0.01,
  chunk_id: 100 + i,
}));
