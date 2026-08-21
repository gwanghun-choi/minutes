import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, CATEGORIES, meeting, mockApi, renderAt, type Route } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const MEETINGS: Route = {
  path: "/api/meetings",
  body: [
    meeting(),
    meeting({ id: 8, title: "8월 고객 방문", category_id: 2, category_name: "고객 미팅" }),
    meeting({ id: 9, title: "분류 안 한 회의", category_id: null, category_name: null }),
  ],
};

const manage = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "카테고리 관리" }));
  return screen.findByRole("dialog");
};

describe("회의 카테고리", () => {
  it("목록에 카테고리가 표시되고 미분류는 미분류라고 쓴다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    const table = within(await screen.findByRole("table"));
    expect(table.getByText("고객 미팅")).toBeInTheDocument();
    expect(table.getByText("미분류")).toBeInTheDocument();
  });

  it("카테고리로 목록을 좁힌다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    await screen.findByRole("option", { name: "고객 미팅" }); // categories arrived
    await userEvent.selectOptions(screen.getByLabelText("카테고리로 거르기"), "2");
    expect(screen.getByText("8월 고객 방문")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });

  it("미분류만 따로 볼 수 있다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    await userEvent.selectOptions(await screen.findByLabelText("카테고리로 거르기"), "none");
    expect(screen.getByText("분류 안 한 회의")).toBeInTheDocument();
    expect(screen.queryByText("8월 고객 방문")).not.toBeInTheDocument();
  });

  it("새 카테고리를 만든다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      {
        method: "POST", path: "/api/meeting-categories",
        body: { id: 3, name: "내부 업무" },
      },
    ]);
    renderAt("/");
    const dialog = await manage();

    await userEvent.type(within(dialog).getByLabelText("새 카테고리 이름"), "내부 업무");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "내부 업무" }),
    );
  });

  it("같은 이름이면 서버가 준 문구를 그대로 보여준다", async () => {
    mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      {
        method: "POST", path: "/api/meeting-categories", status: 409,
        body: { detail: "같은 이름의 카테고리가 이미 있습니다." },
      },
    ]);
    renderAt("/");
    const dialog = await manage();

    await userEvent.type(within(dialog).getByLabelText("새 카테고리 이름"), "개발");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));

    expect(
      await within(dialog).findByText("같은 이름의 카테고리가 이미 있습니다."),
    ).toBeInTheDocument();
  });

  it("이름을 바꾼다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      { method: "PATCH", path: "/api/meeting-categories/1", body: { id: 1, name: "개발팀" } },
    ]);
    renderAt("/");
    const dialog = await manage();

    const field = within(dialog).getByLabelText("개발 이름");
    await userEvent.clear(field);
    await userEvent.type(field, "개발팀");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "개발팀" }),
    );
  });

  it("삭제는 회의가 사라지지 않는다는 것을 먼저 알린다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      { method: "DELETE", path: "/api/meeting-categories/1", body: { id: 1, deleted: true } },
    ]);
    renderAt("/");
    const dialog = await manage();

    await userEvent.click(within(dialog).getByRole("button", { name: "개발 삭제" }));
    expect(
      within(dialog).getByText(/삭제되지 않고 미분류로\s*이동합니다/),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/1"))).toBe(true),
    );
  });

  it("회의 상세에서 카테고리를 지정하고 해제한다", async () => {
    const calls = mockApi([
      AUTH_OK, CATEGORIES,
      {
        path: "/api/meetings/7",
        body: {
          meeting: meeting({ category_id: null, category_name: null }),
          speakers: [], segments: [], my_speaker_id: null,
        },
      },
      { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
      { path: "/api/meetings/7/intelligence", body: { state: "READY", error: null, facts: [] } },
      {
        method: "PUT", path: "/api/meetings/7/category",
        body: { id: 7, category_id: 2, category_name: "고객 미팅" },
      },
    ]);
    renderAt("/meetings/7?tab=overview");

    const select = await screen.findByLabelText("카테고리");
    expect(select).toHaveValue("");
    await screen.findByRole("option", { name: "고객 미팅" }); // categories arrived
    await userEvent.selectOptions(select, "2");

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/category"))?.body).toEqual({
        category_id: 2,
      }),
    );
  });
});
