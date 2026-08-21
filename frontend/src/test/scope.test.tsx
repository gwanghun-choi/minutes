import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, meeting, mockApi, renderAt, type Route } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const SESSIONS: Route = {
  path: "/api/chat/sessions",
  body: [{ id: 3, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-21T00:00:00Z" }],
};

const session = (scope: number[]): Route => ({
  path: "/api/chat/sessions/3",
  body: {
    session: { id: 3, title: "새 채팅", scope_meeting_ids: scope, updated_at: "2026-08-21T00:00:00Z" },
    messages: [],
  },
});

const MEETINGS: Route = {
  path: "/api/meetings",
  body: [
    meeting(),
    meeting({ id: 8, title: "기획 리뷰" }),
    meeting({ id: 9, title: "아직 검토 중", status: "REVIEW_REQUIRED" }),
  ],
};

const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "범위 변경" }));
  return screen.findByRole("dialog");
};

describe("검색 범위", () => {
  it("기본은 전체 회의다", async () => {
    mockApi([AUTH_OK, SESSIONS, session([]), MEETINGS]);
    renderAt("/chat/3");
    expect(await screen.findByText("전체 회의")).toBeInTheDocument();
  });

  it("승인된 회의만 고를 수 있다", async () => {
    mockApi([AUTH_OK, SESSIONS, session([]), MEETINGS]);
    renderAt("/chat/3");
    const dialog = await open();
    expect(within(dialog).getByText("8월 3주차 개발 회의")).toBeInTheDocument();
    expect(within(dialog).queryByText("아직 검토 중")).not.toBeInTheDocument();
  });

  it("✕로 닫을 수 있다", async () => {
    mockApi([AUTH_OK, SESSIONS, session([]), MEETINGS]);
    renderAt("/chat/3");
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("ESC로 닫을 수 있다", async () => {
    mockApi([AUTH_OK, SESSIONS, session([]), MEETINGS]);
    renderAt("/chat/3");
    await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("취소로 닫아도 아무것도 저장되지 않는다", async () => {
    const calls = mockApi([AUTH_OK, SESSIONS, session([]), MEETINGS]);
    renderAt("/chat/3");
    const dialog = await open();
    await userEvent.click(within(dialog).getAllByRole("checkbox")[0]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByText("전체 회의")).toBeInTheDocument();
  });

  it("회의 하나를 고를 수 있다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session([]), MEETINGS,
      {
        method: "PATCH", path: "/api/chat/sessions/3",
        body: { id: 3, title: "새 채팅", scope_meeting_ids: [7] },
      },
    ]);
    renderAt("/chat/3");
    const dialog = await open();
    await userEvent.click(within(dialog).getAllByRole("checkbox")[0]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ scope_meeting_ids: [7] }),
    );
  });

  it("여러 회의를 한 번에 고를 수 있다", async () => {
    const calls = mockApi([
      AUTH_OK, SESSIONS, session([]), MEETINGS,
      {
        method: "PATCH", path: "/api/chat/sessions/3",
        body: { id: 3, title: "새 채팅", scope_meeting_ids: [7, 8] },
      },
    ]);
    renderAt("/chat/3");
    const dialog = await open();
    const boxes = within(dialog).getAllByRole("checkbox");
    await userEvent.click(boxes[0]!);
    await userEvent.click(boxes[1]!);
    expect(within(dialog).getByText("2개 선택됨")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ scope_meeting_ids: [7, 8] }),
    );
  });

  it("저장에 실패하면 창이 열린 채로 남고 범위는 그대로다", async () => {
    mockApi([
      AUTH_OK, SESSIONS, session([]), MEETINGS,
      {
        method: "PATCH", path: "/api/chat/sessions/3", status: 500,
        body: { detail: "저장할 수 없습니다." },
      },
    ]);
    renderAt("/chat/3");
    const dialog = await open();
    await userEvent.click(within(dialog).getAllByRole("checkbox")[0]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));

    expect(await within(dialog).findByText("저장할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The label still reflects the server's scope, not the failed pick.
    expect(screen.getByText("전체 회의")).toBeInTheDocument();
  });

  it("저장된 범위는 대화를 다시 열어도 서버에서 복원된다", async () => {
    mockApi([AUTH_OK, SESSIONS, session([7, 8]), MEETINGS]);
    renderAt("/chat/3");
    expect(await screen.findByText("선택한 회의 2개")).toBeInTheDocument();

    const dialog = await open();
    const checked = within(dialog).getAllByRole("checkbox").filter((b) => (b as HTMLInputElement).checked);
    expect(checked).toHaveLength(2);
  });
});
