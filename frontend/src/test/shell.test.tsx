import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, CATEGORIES, meeting, mockApi, renderAt, type Route } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const MEETINGS: Route = { path: "/api/meetings", body: [meeting()] };

const SESSIONS: Route = {
  path: "/api/chat/sessions",
  body: [
    {
      id: 3, title: "비밀번호 전달 방법", scope_meeting_ids: [], category_id: 1,
      updated_at: new Date().toISOString(),
    },
    {
      id: 2, title: "지난주 배포 일정", scope_meeting_ids: [7], category_id: null,
      updated_at: "2026-07-10T00:00:00Z",
    },
  ],
};

const session = (id: number): Route => ({
  path: `/api/chat/sessions/${id}`,
  body: {
    session: { id, title: "비밀번호 전달 방법", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
    messages: [],
  },
});

const CHAT = [AUTH_OK, MEETINGS, CATEGORIES, SESSIONS, session(3), session(2)];

describe("앱 셸", () => {
  it("대화 목록은 별도 패널이 아니라 셸 사이드바 안에 있다", async () => {
    mockApi(CHAT);
    renderAt("/chat/3");

    // One navigation region, holding both the routes and the conversations.
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const sidebar = nav.closest("aside")!;
    expect(
      await within(sidebar).findByRole("button", { name: "지난주 배포 일정" }),
    ).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "새 채팅" })).toBeInTheDocument();
    expect(within(sidebar).getByLabelText("채팅 검색")).toBeInTheDocument();
  });

  it("현재 route가 어디인지 nav에 표시된다", async () => {
    mockApi(CHAT);
    renderAt("/chat/3");
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    expect(within(nav).getByRole("link", { name: "채팅" })).toHaveAttribute(
      "aria-current", "page",
    );
    expect(within(nav).getByRole("link", { name: "회의" })).not.toHaveAttribute("aria-current");
  });

  it("열려 있는 대화가 표시되고 다른 대화로 옮길 수 있다", async () => {
    mockApi(CHAT);
    renderAt("/chat/3");

    const active = await screen.findByRole("button", { name: "비밀번호 전달 방법" });
    expect(active).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: "지난주 배포 일정" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "지난주 배포 일정" })).toHaveAttribute(
        "aria-current", "page",
      ),
    );
  });

  it("대화는 내 카테고리별로 묶여 있다", async () => {
    // The same personal tree the meeting sidebar uses — one vocabulary for
    // arranging one person's work, and 미분류 last.
    mockApi(CHAT);
    renderAt("/chat/3");
    const sidebar = (await screen.findByRole("navigation", { name: "주요 메뉴" }))
      .closest("aside")!;
    expect(await within(sidebar).findByText("개발")).toBeInTheDocument();
    expect(within(sidebar).getByText("미분류")).toBeInTheDocument();
  });

  it("대화를 다른 카테고리로 옮긴다", async () => {
    const calls = mockApi([
      ...CHAT,
      { method: "PATCH", path: "/api/chat/sessions/2/category", body: { id: 2, category_id: 1 } },
    ]);
    renderAt("/chat/3");

    await userEvent.click(
      await screen.findByRole("button", { name: "지난주 배포 일정 대화 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "카테고리 이동" }));
    await userEvent.selectOptions(await screen.findByLabelText("카테고리"), "1");
    await userEvent.click(screen.getByRole("button", { name: "이동" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ category_id: 1 }),
    );
  });

  it("채팅 검색으로 목록을 좁힌다", async () => {
    mockApi(CHAT);
    renderAt("/chat/3");
    await userEvent.type(await screen.findByLabelText("채팅 검색"), "배포");
    expect(screen.getByRole("button", { name: "지난주 배포 일정" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "비밀번호 전달 방법" })).not.toBeInTheDocument();
  });

  it("새 채팅은 서버가 만든 대화로 이동한다", async () => {
    const calls = mockApi([
      ...CHAT,
      {
        method: "POST", path: "/api/chat/sessions",
        body: { id: 21, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
      },
      {
        path: "/api/chat/sessions/21",
        body: {
          session: { id: 21, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" },
          messages: [],
        },
      },
    ]);
    renderAt("/chat/3");

    await userEvent.click(await screen.findByRole("button", { name: "새 채팅" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ scope_meeting_ids: [] }),
    );
  });

  it("회의 화면에서는 대화 목록을 들고 다니지 않는다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES, SESSIONS]);
    renderAt("/");
    await screen.findByRole("heading", { name: "회의" });
    expect(screen.queryByRole("button", { name: "새 채팅" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("채팅 검색")).not.toBeInTheDocument();
  });
});
