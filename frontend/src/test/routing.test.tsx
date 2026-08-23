import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, meeting, mockApi, renderAt, type Route } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const SESSIONS_EMPTY: Route = { path: "/api/chat/sessions", body: [] };
const MEETINGS: Route = { path: "/api/meetings", body: [meeting()] };

describe("라우팅", () => {
  it("알 수 없는 경로는 404 화면이다", async () => {
    mockApi([AUTH_OK]);
    renderAt("/nope");
    expect(
      await screen.findByRole("heading", { name: "페이지를 찾을 수 없습니다" }),
    ).toBeInTheDocument();
  });

  it("/chat 은 가장 최근 대화를 연다", async () => {
    mockApi([
      AUTH_OK, MEETINGS,
      {
        path: "/api/chat/sessions",
        body: [
          { id: 9, title: "최근 대화", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
          { id: 4, title: "예전 대화", scope_meeting_ids: [], updated_at: "2026-08-01T00:00:00Z" },
        ],
      },
      {
        path: "/api/chat/sessions/9",
        body: {
          session: { id: 9, title: "최근 대화", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
          messages: [],
        },
      },
    ]);
    renderAt("/chat");
    expect(await screen.findByText("회의록에 물어보세요.")).toBeInTheDocument();
  });

  it("대화가 하나도 없으면 새로 만든다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, SESSIONS_EMPTY,
      {
        method: "POST", path: "/api/chat/sessions",
        body: { id: 12, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
      },
      {
        path: "/api/chat/sessions/12",
        body: {
          session: { id: 12, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
          messages: [],
        },
      },
    ]);
    renderAt("/chat");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ scope_meeting_ids: [] }),
    );
  });

  it("회의 상세의 '이 회의에 질문하기' 링크(?meeting_id)는 그 회의로 범위를 좁힌 대화를 만든다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, SESSIONS_EMPTY,
      {
        method: "POST", path: "/api/chat/sessions",
        body: { id: 13, title: "새 채팅", scope_meeting_ids: [7], updated_at: "2026-08-21T00:00:00Z" },
      },
      {
        path: "/api/chat/sessions/13",
        body: {
          session: { id: 13, title: "새 채팅", scope_meeting_ids: [7], updated_at: "2026-08-21T00:00:00Z" },
          messages: [],
        },
      },
    ]);
    renderAt("/chat?meeting_id=7");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ scope_meeting_ids: [7] }),
    );
    expect(await screen.findByText("선택한 회의 1개")).toBeInTheDocument();
  });
});
