import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_OK, CATEGORIES, CATEGORY_TREE, meeting, meetingDetail, meetingsRoute,
  MEETINGS_PATH, mockApi, renderAt, sharesRoute, type Route,
} from "./harness";

afterEach(() => vi.unstubAllGlobals());

const MEETINGS: Route = meetingsRoute([
  meeting(),
  meeting({ id: 8, title: "8월 고객 방문", category_id: 2, category_name: "고객 미팅" }),
  meeting({ id: 9, title: "분류 안 한 회의", category_id: null, category_name: null }),
]);

/** The last list request, as parameters. */
const lastQuery = (calls: { method: string; url: string }[]) =>
  new URL(
    calls.filter((c) => c.method === "GET" && MEETINGS_PATH.test(c.url)).at(-1)!.url,
    "http://localhost",
  ).searchParams;

const sidebar = async () =>
  within((await screen.findByRole("navigation", { name: "주요 메뉴" })).closest("aside")!);

describe("회의 목록의 카테고리", () => {
  it("목록에 카테고리가 표시되고 미분류는 미분류라고 쓴다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    const table = within(await screen.findByRole("table"));
    expect(table.getByText("고객 미팅")).toBeInTheDocument();
    expect(table.getByText("미분류")).toBeInTheDocument();
  });

  it("카테고리로 목록을 좁힌다", async () => {
    const calls = mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    await screen.findByRole("option", { name: "고객 미팅" }); // categories arrived
    await userEvent.selectOptions(screen.getByLabelText("카테고리로 거르기"), "2");

    await waitFor(() => expect(lastQuery(calls).get("category")).toBe("2"));
    expect(screen.getByText("8월 고객 방문")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });

  it("미분류만 따로 볼 수 있다", async () => {
    const calls = mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    await userEvent.selectOptions(await screen.findByLabelText("카테고리로 거르기"), "none");

    await waitFor(() => expect(lastQuery(calls).get("category")).toBe("none"));
    expect(screen.getByText("분류 안 한 회의")).toBeInTheDocument();
    expect(screen.queryByText("8월 고객 방문")).not.toBeInTheDocument();
  });

  it("따로 관리하는 화면으로 나가지 않는다", async () => {
    // Managing categories used to mean leaving the list to organise the list.
    mockApi([AUTH_OK, MEETINGS, CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");
    expect(screen.queryByRole("link", { name: "카테고리 관리" })).not.toBeInTheDocument();
  });
});

describe("사이드바 카테고리 트리", () => {
  it("계층 구조가 보이고 하위 카테고리를 고를 수 있다", async () => {
    const calls = mockApi([AUTH_OK, MEETINGS, CATEGORY_TREE]);
    renderAt("/");

    const tree = await sidebar();
    expect(await tree.findByRole("link", { name: /업무/ })).toBeInTheDocument();
    await userEvent.click(tree.getByRole("button", { name: "업무 펼치기" }));
    await userEvent.click(tree.getByRole("link", { name: /개발/ }));
    await waitFor(() => expect(lastQuery(calls).get("category")).toBe("3"));
  });

  it("상위 카테고리를 고르면 그 상위 id로 조회한다", async () => {
    // The descendant rule lives in SQL; what the tree owes is the parent's id.
    const calls = mockApi([AUTH_OK, MEETINGS, CATEGORY_TREE]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("link", { name: /^업무/ }));
    await waitFor(() => expect(lastQuery(calls).get("category")).toBe("2"));
  });

  it("펼치기 전에는 하위와 회의를 그리지 않는다", async () => {
    // A sidebar that renders every meeting stops being navigable exactly when it
    // is needed, so nothing under a category is fetched until it is opened.
    mockApi([AUTH_OK, MEETINGS, CATEGORY_TREE]);
    renderAt("/");

    expect(await screen.findByRole("link", { name: /^업무/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /운영/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "업무 펼치기" }));
    expect(await screen.findByRole("link", { name: /운영/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "업무 접기" }));
    expect(screen.queryByRole("link", { name: /운영/ })).not.toBeInTheDocument();
  });

  it("펼치면 최근 회의가 보이고 나머지는 전체 보기로 넘긴다", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      meeting({ id: 100 + i, title: `업무 회의 ${i}`, category_id: 2, category_name: "업무" }),
    );
    mockApi([AUTH_OK, meetingsRoute(many), CATEGORY_TREE]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "업무 펼치기" }));
    const tree = await sidebar();
    expect(await tree.findByRole("link", { name: "업무 회의 0" })).toBeInTheDocument();
    expect(tree.queryByRole("link", { name: "업무 회의 6" })).not.toBeInTheDocument();
    expect(tree.getByRole("link", { name: /전체 보기/ })).toHaveAttribute(
      "href", "/?category=2",
    );
  });

  it("전체 회의와 미분류도 트리에서 고를 수 있다", async () => {
    const calls = mockApi([AUTH_OK, MEETINGS, CATEGORY_TREE]);
    renderAt("/?category=3");

    await userEvent.click(await screen.findByRole("link", { name: "미분류" }));
    await waitFor(() => expect(lastQuery(calls).get("category")).toBe("none"));

    await userEvent.click(screen.getByRole("link", { name: "전체 회의" }));
    await waitFor(() => expect(lastQuery(calls).get("category")).toBeNull());
  });
});

describe("사이드바에서 카테고리를 관리한다", () => {
  const created = (body: unknown): Route => ({
    method: "POST", path: "/api/meeting-categories", body,
  });

  it("카테고리가 없으면 무엇을 하면 되는지 알려준다", async () => {
    mockApi([AUTH_OK, MEETINGS, { path: "/api/meeting-categories", body: [] }]);
    renderAt("/");
    expect(await screen.findByText(/아직 카테고리가 없습니다/)).toBeInTheDocument();
  });

  it("[+]로 최상위 카테고리를 만든다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      created({ id: 9, name: "고객사 A", parent_id: null }),
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "새 카테고리" }));
    await userEvent.type(await screen.findByLabelText("이름"), "고객사 A");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        name: "고객사 A", parent_id: null,
      }),
    );
  });

  it("행 메뉴에서 하위 카테고리를 만든다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      created({ id: 9, name: "신규", parent_id: 2 }),
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "업무 카테고리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "하위 카테고리 추가" }));
    await userEvent.type(await screen.findByLabelText("이름"), "신규");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        name: "신규", parent_id: 2,
      }),
    );
  });

  it("이름을 바꾼다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      { method: "PATCH", path: "/api/meeting-categories/2", body: { id: 2, name: "업무팀", parent_id: null } },
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "업무 카테고리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "이름 변경" }));
    const field = await screen.findByLabelText("이름");
    await userEvent.clear(field);
    await userEvent.type(field, "업무팀");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "업무팀" }),
    );
  });

  it("같은 이름이면 서버가 준 문구를 그대로 보여준다", async () => {
    mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      {
        method: "POST", path: "/api/meeting-categories", status: 409,
        body: { detail: "같은 이름의 카테고리가 이미 있습니다." },
      },
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "새 카테고리" }));
    await userEvent.type(await screen.findByLabelText("이름"), "업무");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect(await screen.findByText("같은 이름의 카테고리가 이미 있습니다.")).toBeInTheDocument();
  });

  it("상위 카테고리를 바꾼다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      { method: "PUT", path: "/api/meeting-categories/1/parent", body: { id: 1, name: "개인", parent_id: 2 } },
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "개인 카테고리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "상위 카테고리 변경" }));
    await userEvent.selectOptions(await screen.findByLabelText("상위 카테고리"), "2");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ parent_id: 2 }),
    );
  });

  it("자기 자신과 자기 하위는 상위 후보로 제시하지 않는다", async () => {
    mockApi([AUTH_OK, MEETINGS, CATEGORY_TREE]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "업무 카테고리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "상위 카테고리 변경" }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByRole("option", { name: "개인" })).toBeInTheDocument();
    expect(dialog.queryByRole("option", { name: "업무" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("option", { name: "업무 / 개발" })).not.toBeInTheDocument();
  });

  it("삭제는 회의와 채팅이 사라지지 않는다는 것을 먼저 알린다", async () => {
    const calls = mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      { method: "DELETE", path: "/api/meeting-categories/1", body: { deleted: true } },
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "개인 카테고리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/폴더만 사라집니다/)).toBeInTheDocument();

    await userEvent.click(dialog.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("하위가 있는 카테고리는 서버가 이유를 돌려준다", async () => {
    mockApi([
      AUTH_OK, MEETINGS, CATEGORY_TREE,
      {
        method: "DELETE", path: "/api/meeting-categories/2", status: 409,
        body: { detail: "하위 카테고리 2개가 있어 삭제할 수 없습니다. 하위 카테고리를 먼저 옮기거나 삭제해 주세요." },
      },
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "업무 카테고리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    expect(await screen.findByText(/하위 카테고리 2개가 있어/)).toBeInTheDocument();
  });
});

describe("회의 상세의 내 정리", () => {
  const DETAIL_ROUTES = (over: Record<string, unknown> = {}): Route[] => [
    AUTH_OK, CATEGORY_TREE,
    {
      path: "/api/meetings/7",
      body: meetingDetail({
        category_id: null, category_name: null,
        speakers: [], segments: [], my_speaker_id: null, ...over,
      }),
    },
    sharesRoute(),
    { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
    { path: "/api/meetings/7/intelligence", body: { state: "READY", error: null, facts: [] } },
  ];

  it("카테고리를 계층 경로로 보여주고 지정하면 서버에 저장한다", async () => {
    const calls = mockApi([
      ...DETAIL_ROUTES(),
      {
        method: "PUT", path: "/api/meetings/7/category",
        body: { id: 7, category_id: 3, category_name: "개발" },
      },
    ]);
    renderAt("/meetings/7?tab=overview");

    const select = await screen.findByLabelText("카테고리");
    expect(select).toHaveValue("");
    // The hierarchy is legible in a plain select, as a path.
    expect(await screen.findByRole("option", { name: "업무 / 개발" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "3");

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/category"))?.body).toEqual({
        category_id: 3,
      }),
    );
  });

  it("공유받은 사람도 자기 카테고리와 표시 이름을 정한다", async () => {
    // The whole point of the split: this writes the reader's own filing row and
    // the server refuses every canonical field either way.
    const calls = mockApi([
      ...DETAIL_ROUTES({ role: "SHARED_READ", shared_with: null, owner_display_name: "최광훈" }),
      {
        method: "PUT", path: "/api/meetings/7/alias",
        body: { id: 7, alias: "정산 사례", display_title: "정산 사례" },
      },
    ]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByLabelText("카테고리")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("내 표시 이름"), "정산 사례");
    await userEvent.click(screen.getByRole("button", { name: "표시 이름 저장" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/alias"))?.body).toEqual({
        alias: "정산 사례",
      }),
    );
  });

  it("표시 이름을 비우면 원래 이름으로 되돌린다", async () => {
    const calls = mockApi([
      ...DETAIL_ROUTES({ alias: "내가 붙인 이름" }),
      {
        method: "PUT", path: "/api/meetings/7/alias",
        body: { id: 7, alias: null, display_title: "8월 3주차 개발 회의" },
      },
    ]);
    renderAt("/meetings/7?tab=overview");

    // the page shows my name, and says which one is the meeting's own
    expect(await screen.findByRole("heading", { name: "내가 붙인 이름" })).toBeInTheDocument();
    expect(screen.getByText(/원래 이름: 8월 3주차 개발 회의/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("내 표시 이름"));
    await userEvent.click(screen.getByRole("button", { name: "표시 이름 저장" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/alias"))?.body).toEqual({
        alias: null,
      }),
    );
  });
});
