import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, meeting, mockApi, renderAt } from "./harness";

afterEach(() => vi.unstubAllGlobals());

describe("회의 목록", () => {
  it("불러오는 동안 자리표시자를 보여준다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: [] }]);
    renderAt("/");
    expect(await screen.findByLabelText("불러오는 중")).toBeInTheDocument();
  });

  it("회의가 하나도 없으면 무엇을 하면 되는지 알려준다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: [] }]);
    renderAt("/");
    expect(await screen.findByText("아직 회의가 없습니다.")).toBeInTheDocument();
  });

  it("회의를 표로 보여주고 상태를 한국어로 쓴다", async () => {
    mockApi([
      AUTH_OK,
      {
        path: "/api/meetings",
        body: [meeting(), meeting({ id: 8, title: "기획 리뷰", status: "REVIEW_REQUIRED" })],
      },
    ]);
    renderAt("/");
    expect(await screen.findByText("8월 3주차 개발 회의")).toBeInTheDocument();
    // Scoped to the table: the same words are also the status filter's options.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("검토 필요")).toBeInTheDocument();
    expect(table.getByText("완료")).toBeInTheDocument();
  });

  it("held_at이 없으면 등록일이라고 밝히고 회의 일시인 척하지 않는다", async () => {
    mockApi([
      AUTH_OK,
      { path: "/api/meetings", body: [meeting({ held_at: null })] },
    ]);
    renderAt("/");
    const row = (await screen.findByText("8월 3주차 개발 회의")).closest("tr")!;
    expect(within(row).getByText(/등록$/)).toBeInTheDocument();
  });

  it("검색어로 목록을 좁힌다", async () => {
    mockApi([
      AUTH_OK,
      { path: "/api/meetings", body: [meeting(), meeting({ id: 8, title: "기획 리뷰" })] },
    ]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "기획");
    expect(screen.getByText("기획 리뷰")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });
});
