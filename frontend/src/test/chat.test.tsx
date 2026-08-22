import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_OK, CATEGORIES, meeting, meetingsRoute, mockApi, renderAt, SIX_SOURCES,
  SOURCE_FACT, type Route,
} from "./harness";

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

const MEETINGS: Route = meetingsRoute([meeting()]);

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

    // The evidence is stored and counted, but nothing of it is on screen until
    // the reader asks — the answer is what they came for. The user-facing word
    // is 출처.
    const toggle = screen.getByRole("button", { name: "출처 1개" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/문자로 남겨드리겠습니다/)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    const panel = within(await screen.findByRole("complementary", { name: "출처" }));
    expect(panel.getByText(/문자로 남겨드리겠습니다/)).toBeInTheDocument();
    expect(panel.getByText("할 일")).toBeInTheDocument();
    // The card links back to the meeting, and to the position in its transcript.
    expect(panel.getByRole("link", { name: "회의록에서 보기" })).toHaveAttribute(
      "href", "/meetings/7?tab=transcript&at=5",
    );
  });

  it("답변 안의 [1]을 누르면 그 출처가 열리고 선택된다", async () => {
    mockApi([AUTH_OK, SESSIONS, session(), MEETINGS]);
    renderAt("/chat/3");

    // The citation the model wrote is a way into the panel, not decoration.
    await userEvent.click(await screen.findByRole("button", { name: "출처 1 보기" }));
    const panel = await screen.findByRole("complementary", { name: "출처" });
    expect(within(panel).getByText(/문자로 남겨드리겠습니다/)).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "출처 닫기" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "출처" })).not.toBeInTheDocument(),
    );
  });

  it("출처 패널은 ESC로 닫힌다", async () => {
    mockApi([AUTH_OK, SESSIONS, session(), MEETINGS]);
    renderAt("/chat/3");

    await userEvent.click(await screen.findByRole("button", { name: "출처 1개" }));
    expect(await screen.findByRole("complementary", { name: "출처" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "출처" })).not.toBeInTheDocument(),
    );
  });

  it("출처가 없는 답변에는 출처 버튼이 없다", async () => {
    mockApi([
      AUTH_OK, SESSIONS, MEETINGS,
      {
        path: "/api/chat/sessions/3",
        body: {
          session: {
            id: 3, title: "출처 없음", scope_meeting_ids: [],
            updated_at: "2026-08-21T00:00:00Z",
          },
          messages: [
            { role: "user", content: "배포 일정?", sources: [] },
            { role: "assistant", content: "아래와 같이 정리했습니다.", sources: [] },
          ],
        },
      },
    ]);
    renderAt("/chat/3");

    expect(await screen.findByText("아래와 같이 정리했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^출처 \d+개$/ })).not.toBeInTheDocument();
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

  it("출처는 기본으로 하나도 보이지 않고, 열면 전부 나온다", async () => {
    mockApi([
      AUTH_OK, SESSIONS, CATEGORIES, MEETINGS,
      {
        path: "/api/chat/sessions/3",
        body: {
          session: {
            id: 3, title: "여섯 근거", scope_meeting_ids: [],
            updated_at: "2026-08-21T00:00:00Z",
          },
          messages: [
            { role: "user", content: "배포 일정?", sources: [] },
            { role: "assistant", content: "정리하면 다음과 같습니다.", sources: SIX_SOURCES },
          ],
        },
      },
    ]);
    renderAt("/chat/3");

    // The count is honest about the whole retrieved set; none of it is shown.
    const toggle = await screen.findByRole("button", { name: "출처 6개" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    for (let i = 1; i <= 6; i += 1) {
      expect(screen.queryByText(`근거 본문 ${i}번입니다.`)).not.toBeInTheDocument();
    }

    await userEvent.click(toggle);

    // Every retrieved source is there — nothing was dropped to shorten the
    // panel, only moved out of the reading column.
    const panel = within(await screen.findByRole("complementary", { name: "출처" }));
    for (let i = 1; i <= 6; i += 1) {
      expect(panel.getByText(`근거 본문 ${i}번입니다.`)).toBeInTheDocument();
    }
    await userEvent.click(panel.getByRole("button", { name: "출처 닫기" }));
    expect(screen.queryByText("근거 본문 1번입니다.")).not.toBeInTheDocument();
  });

  it("대화 이름을 바꾸면 사이드바와 현재 대화 제목에 함께 반영된다", async () => {
    let title = "비밀번호 전달 방법";
    const calls = mockApi([
      AUTH_OK, MEETINGS,
      { path: "/api/chat/sessions", reply: () => ({ body: [
        { id: 3, title, scope_meeting_ids: [], updated_at: new Date().toISOString() },
      ] }) },
      { path: "/api/chat/sessions/3", reply: () => ({ body: {
        session: { id: 3, title, scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
        messages: [],
      } }) },
      {
        method: "PATCH", path: "/api/chat/sessions/3/title",
        reply: (call) => {
          title = (call.body as { title: string }).title;
          return { body: { id: 3, title, scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" } };
        },
      },
    ]);
    renderAt("/chat/3");

    // The chat header carries the same name the sidebar row does.
    expect(await screen.findByRole("heading", { name: "비밀번호 전달 방법" })).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole("button", { name: "비밀번호 전달 방법 대화 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "이름 변경" }));

    const field = await screen.findByLabelText("대화 이름");
    await userEvent.clear(field);
    await userEvent.type(field, "현관 비밀번호{Enter}");

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "현관 비밀번호" }),
    );
    expect(await screen.findByRole("button", { name: "현관 비밀번호" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "현관 비밀번호" })).toBeInTheDocument();
  });

  it("이름 변경은 Esc로 취소되고 서버를 부르지 않는다", async () => {
    const calls = mockApi([AUTH_OK, SESSIONS, session(), MEETINGS]);
    renderAt("/chat/3");

    await userEvent.click(
      await screen.findByRole("button", { name: "지난주 배포 일정 대화 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "이름 변경" }));

    const field = await screen.findByLabelText("대화 이름");
    await userEvent.clear(field);
    await userEvent.type(field, "버려질 이름{Escape}");

    expect(await screen.findByRole("button", { name: "지난주 배포 일정" })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("빈 이름은 저장할 수 없다", async () => {
    const calls = mockApi([AUTH_OK, SESSIONS, session(), MEETINGS]);
    renderAt("/chat/3");

    await userEvent.click(
      await screen.findByRole("button", { name: "지난주 배포 일정 대화 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "이름 변경" }));
    await userEvent.clear(await screen.findByLabelText("대화 이름"));

    expect(screen.getByRole("button", { name: "이름 저장" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("대화 이름"), "{Enter}");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("대화 삭제는 확인을 거친다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session(), MEETINGS,
      { method: "DELETE", path: "/api/chat/sessions/2", body: { id: 2, deleted: true } },
    ]);
    renderAt("/chat/3");

    await userEvent.click(
      await screen.findByRole("button", { name: "지난주 배포 일정 대화 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
