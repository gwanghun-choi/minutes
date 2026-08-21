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

describe("회의 목록의 카테고리", () => {
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

  it("관리는 필터가 아니라 목록에서 나가는 링크다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    const link = await screen.findByRole("link", { name: "카테고리 관리" });
    expect(link).toHaveAttribute("href", "/categories");

    await userEvent.click(link);
    expect(await screen.findByRole("heading", { name: "카테고리 관리" })).toBeInTheDocument();
  });
});

describe("카테고리 관리 화면", () => {
  it("카테고리와 회의 수를 보여주고 회의 목록으로 돌아갈 수 있다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/categories");

    expect(await screen.findByText("개발")).toBeInTheDocument();
    expect(screen.getByText("회의 1개")).toBeInTheDocument();
    expect(screen.getByLabelText("회의 목록으로")).toHaveAttribute("href", "/");
  });

  it("카테고리가 없으면 무엇을 하면 되는지 알려준다", async () => {
    mockApi([AUTH_OK, MEETINGS, { path: "/api/meeting-categories", body: [] }]);
    renderAt("/categories");
    expect(await screen.findByText("아직 카테고리가 없습니다.")).toBeInTheDocument();
  });

  it("새 카테고리를 만든다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      { method: "POST", path: "/api/meeting-categories", body: { id: 3, name: "내부 업무" } },
    ]);
    renderAt("/categories");

    await userEvent.type(await screen.findByLabelText("새 카테고리 이름"), "내부 업무");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

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
    renderAt("/categories");

    await userEvent.type(await screen.findByLabelText("새 카테고리 이름"), "개발");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect(
      await screen.findByText("같은 이름의 카테고리가 이미 있습니다."),
    ).toBeInTheDocument();
  });

  it("이름을 바꾼다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      { method: "PATCH", path: "/api/meeting-categories/1", body: { id: 1, name: "개발팀" } },
    ]);
    renderAt("/categories");

    await userEvent.click(await screen.findByRole("button", { name: "개발 이름 변경" }));
    const field = screen.getByLabelText("개발 이름");
    await userEvent.clear(field);
    await userEvent.type(field, "개발팀");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "개발팀" }),
    );
  });

  it("이름 변경은 취소할 수 있고 서버를 부르지 않는다", async () => {
    const calls = mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/categories");

    await userEvent.click(await screen.findByRole("button", { name: "개발 이름 변경" }));
    await userEvent.type(screen.getByLabelText("개발 이름"), "버릴 이름");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(screen.getByText("개발")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("삭제는 회의가 사라지지 않는다는 것을 먼저 알린다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORIES,
      { method: "DELETE", path: "/api/meeting-categories/1", body: { id: 1, deleted: true } },
    ]);
    renderAt("/categories");

    await userEvent.click(await screen.findByRole("button", { name: "개발 삭제" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/삭제되지 않고 미분류로\s*이동합니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(dialog.getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/1"))).toBe(true),
    );
  });
});

describe("회의 상세의 카테고리", () => {
  it("카테고리를 지정하면 서버에 저장한다", async () => {
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
