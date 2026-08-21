import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, meeting, mockApi, renderAt, SOURCE_FACT, type Route } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const SESSIONS: Route = {
  path: "/api/chat/sessions",
  body: [
    { id: 3, title: "비밀번호 전달 방법", scope_meeting_ids: [], updated_at: new Date().toISOString() },
    { id: 2, title: "지난주 배포 일정", scope_meeting_ids: [7], updated_at: "2026-08-10T00:00:00Z" },
  ],
};

const session = (over: Record<string, unknown> = {}): Route => ({
  path: "/api/chat/sessions/3",
  body: {
    session: { id: 3, title: "비밀번호 전달 방법", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
    messages: [
      { role: "user", content: "내가 집 비밀번호를 어떻게 전달하기로 했어?", sources: [] },
      {
        role: "assistant",
        content: "통화 종료 후 문자로 전달하기로 하셨습니다. [1]",
        sources: [SOURCE_FACT],
      },
    ],
    ...over,
  },
});

const MEETINGS: Route = { path: "/api/meetings", body: [meeting()] };

describe("채팅", () => {
  it("사이드바에 지난 대화가 시간대별로 남는다", async () => {
    mockApi([AUTH_OK, SESSIONS, session(), MEETINGS]);
    renderAt("/chat/3");
    expect(await screen.findByRole("button", { name: "지난주 배포 일정" })).toBeInTheDocument();
    expect(screen.getByText("오늘")).toBeInTheDocument();
  });

  it("새로 열어도 서버에 저장된 대화와 근거가 그대로 복원된다", async () => {
    mockApi([AUTH_OK, SESSIONS, session(), MEETINGS]);
    renderAt("/chat/3");

    expect(await screen.findByText("내가 집 비밀번호를 어떻게 전달하기로 했어?")).toBeInTheDocument();
    expect(screen.getByText(/통화 종료 후 문자로 전달하기로 하셨습니다/)).toBeInTheDocument();

    // Evidence is one click away, never louder than the answer itself.
    const toggle = screen.getByRole("button", { name: "근거 1개" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(await screen.findByText(/문자로 남겨드리겠습니다/)).toBeInTheDocument();
    expect(screen.getByText("할 일")).toBeInTheDocument();
  });

  it("질문을 보내면 서버가 저장한 대화를 다시 읽어 그린다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session(), MEETINGS,
      {
        method: "POST", path: "/api/chat/sessions/3/messages",
        body: { answer: "문자로 전달합니다. [1]", sources: [SOURCE_FACT], scope_miss: false },
      },
    ]);
    renderAt("/chat/3");

    await userEvent.type(await screen.findByLabelText("질문"), "누가 보내기로 했어?");
    await userEvent.click(screen.getByRole("button", { name: "질문 보내기" }));

    await waitFor(() => {
      const ask = calls.find((c) => c.url.endsWith("/messages"));
      expect(ask?.body).toEqual({ question: "누가 보내기로 했어?", global_override: false });
    });
  });

  it("Enter로 보내고 Shift+Enter는 줄바꿈이다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session(), MEETINGS,
      {
        method: "POST", path: "/api/chat/sessions/3/messages",
        body: { answer: "네.", sources: [], scope_miss: false },
      },
    ]);
    renderAt("/chat/3");

    const box = await screen.findByLabelText("질문");
    await userEvent.type(box, "첫 줄{Shift>}{Enter}{/Shift}둘째 줄");
    expect(box).toHaveValue("첫 줄\n둘째 줄");
    expect(calls.some((c) => c.url.endsWith("/messages"))).toBe(false);

    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/messages"))).toBe(true));
  });

  it("선택한 범위에서 못 찾으면 스스로 전체 검색하지 않고 물어본다", async () => {
    mockApi([
      AUTH_OK, SESSIONS, session(), MEETINGS,
      {
        method: "POST", path: "/api/chat/sessions/3/messages",
        body: {
          answer: "회의록에서 해당 내용을 찾지 못했습니다.", sources: [], scope_miss: true,
        },
      },
    ]);
    renderAt("/chat/3");

    await userEvent.type(await screen.findByLabelText("질문"), "배포 일정은?");
    await userEvent.click(screen.getByRole("button", { name: "질문 보내기" }));

    expect(
      await screen.findByText("선택한 회의에서는 해당 내용을 찾지 못했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "전체 회의에서 다시 검색" })).toBeInTheDocument();
  });

  it("전체 검색은 그 질문 한 번에만 적용되고 세션 범위는 건드리지 않는다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session(), MEETINGS,
      {
        method: "POST", path: "/api/chat/sessions/3/messages",
        reply: (call) => ({
          body: {
            answer: "답변",
            sources: [],
            scope_miss: !(call.body as { global_override: boolean }).global_override,
          },
        }),
      },
    ]);
    renderAt("/chat/3");

    await userEvent.type(await screen.findByLabelText("질문"), "배포 일정은?");
    await userEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "전체 회의에서 다시 검색" }),
    );

    await waitFor(() => {
      const asks = calls.filter((c) => c.url.endsWith("/messages"));
      expect(asks).toHaveLength(2);
      expect(asks[1]!.body).toEqual({ question: "배포 일정은?", global_override: true });
    });
    // Only the question was widened. No PATCH ever touched the session's scope.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("대화 삭제는 확인을 거친다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session(), MEETINGS,
      { method: "DELETE", path: "/api/chat/sessions/2", body: { id: 2, deleted: true } },
    ]);
    renderAt("/chat/3");

    await userEvent.click(
      await screen.findByRole("button", { name: "지난주 배포 일정 대화 삭제" }),
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
