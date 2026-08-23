import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NAV_ROW_ACTIVE, NAV_ROW_SELECTED } from "../components/AppShell";
import {
  AUTH_OK, CATEGORY_TREE, CATEGORY_TREE_ROWS, CATEGORIES, categoryTree, meeting,
  meetingDetail, NO_CATEGORIES,
  meetingsRoute, MEETINGS_PATH, mockApi, renderAt, sharesRoute, type Route,
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

    await userEvent.click(await screen.findByRole("link", { name: /^미분류/ }));
    await waitFor(() => expect(lastQuery(calls).get("category")).toBe("none"));

    await userEvent.click(screen.getByRole("link", { name: /^전체 회의/ }));
    await waitFor(() => expect(lastQuery(calls).get("category")).toBeNull());
  });
});

/*
  Three questions the sidebar answers, and they are not one question.

  Reported as: opening 지오영 > 지오영 테스트 음성파일 left 전체 회의 and the meeting
  both wearing the same grey, so nothing said which of them you were looking at.
  The cause was one `active` string read off `?category` — on a detail route
  there is no such parameter, so "no filter" and "no list at all" were both "".
*/
describe("사이드바 선택 상태", () => {
  /** The surface that means "this is the list on screen". Nothing else may wear it. */
  const ACTIVE_SURFACE = NAV_ROW_ACTIVE.split(" ")[0]!;

  /* Scoped to the tree's own landmark, not the whole sidebar: 주요 메뉴 marks the
     current *section* and this marks the current *row*, and each region is
     allowed exactly one. Counting across both would be counting two answers to
     two questions. */
  const treeNav = async () =>
    within(await screen.findByRole("navigation", { name: "카테고리 탐색" }));

  /* One rule for the whole tree, instead of a count: every row marked current
     points at the URL you are on. It cannot be satisfied by a filter row on a
     detail page, which is exactly what went wrong. */
  const currentTargets = async () => [
    ...new Set(
      (await treeNav())
        .getAllByRole("link")
        .filter((a) => a.getAttribute("aria-current") === "page")
        .map((a) => a.getAttribute("href")),
    ),
  ];

  const wearingActiveSurface = async () =>
    (await treeNav()).getAllByRole("link").filter((a) => a.classList.contains(ACTIVE_SURFACE));

  /** 업무 / 개발 (id 3), holding the two meetings the tree can show. */
  const FILED = [
    meeting({ id: 7, title: "지오영 테스트 음성파일", category_id: 3, category_name: "개발" }),
    meeting({ id: 8, title: "정산 후속 회의", category_id: 3, category_name: "개발" }),
    meeting({ id: 9, title: "분류 안 한 회의", category_id: null, category_name: null }),
  ];

  const detailRoutes = (id: number, over: Record<string, unknown>): Route[] => [
    {
      path: `/api/meetings/${id}`,
      body: meetingDetail({ id, speakers: [], segments: [], my_speaker_id: null, ...over }),
    },
    sharesRoute(id),
    { path: `/api/meetings/${id}/summary`, status: 404, body: { detail: "없음" } },
    { path: `/api/meetings/${id}/intelligence`, body: { state: "READY", error: null, facts: [] } },
  ];

  const TREE_ROUTES: Route[] = [AUTH_OK, meetingsRoute(FILED), CATEGORY_TREE];

  it("A. 전체 목록에서는 전체 회의만 현재다", async () => {
    mockApi(TREE_ROUTES);
    renderAt("/");

    const tree = await treeNav();
    expect(tree.getByRole("link", { name: /^전체 회의/ })).toHaveAttribute("aria-current", "page");
    expect(await currentTargets()).toEqual(["/"]);
    expect(await wearingActiveSurface()).toHaveLength(1);
  });

  it("B. 카테고리 목록에서는 그 카테고리만 현재다", async () => {
    mockApi(TREE_ROUTES);
    renderAt("/?category=3");

    const tree = await treeNav();
    await userEvent.click(await tree.findByRole("button", { name: "업무 펼치기" }));
    expect(await tree.findByRole("link", { name: /^개발/ })).toHaveAttribute(
      "aria-current", "page",
    );
    expect(tree.getByRole("link", { name: /^전체 회의/ })).not.toHaveAttribute("aria-current");
    // Its parent is unfolded to show it. That is not the same as being current.
    expect(tree.getByRole("link", { name: /^업무/ })).not.toHaveAttribute("aria-current");
    expect(await currentTargets()).toEqual(["/?category=3"]);
  });

  it("C. 회의 상세에서는 그 회의만 선택되고 전체 회의는 풀린다", async () => {
    mockApi([...TREE_ROUTES, ...detailRoutes(7, {
      title: "지오영 테스트 음성파일", category_id: 3, category_name: "개발",
    })]);
    renderAt("/meetings/7");

    const tree = await treeNav();
    const row = await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    expect(row).toHaveAttribute("aria-current", "page");
    expect(row).toHaveClass(...NAV_ROW_SELECTED.split(" "));

    expect(tree.getByRole("link", { name: /^전체 회의/ })).not.toHaveAttribute("aria-current");
    expect(tree.getByRole("link", { name: /^미분류/ })).not.toHaveAttribute("aria-current");
    expect(tree.getByRole("link", { name: /^개발/ })).not.toHaveAttribute("aria-current");
    expect(await currentTargets()).toEqual(["/meetings/7"]);
    // The reported defect, as one assertion: no row is wearing the filter's
    // surface, because no list is on screen.
    expect(await wearingActiveSurface()).toHaveLength(0);
  });

  it("C2. 그 회의가 든 카테고리는 펼쳐지기만 한다", async () => {
    mockApi([...TREE_ROUTES, ...detailRoutes(7, {
      title: "지오영 테스트 음성파일", category_id: 3, category_name: "개발",
    })]);
    renderAt("/meetings/7");

    const tree = await treeNav();
    // Unfolded all the way down to it, without being asked, and 접기 is offered —
    // expanded is a state the reader still owns.
    expect(await tree.findByRole("button", { name: "업무 접기" })).toHaveAttribute(
      "aria-expanded", "true",
    );
    expect(tree.getByRole("button", { name: "개발 접기" })).toHaveAttribute(
      "aria-expanded", "true",
    );
    expect(tree.getByRole("button", { name: "개인 펼치기" })).toHaveAttribute(
      "aria-expanded", "false",
    );
  });

  it("D. 미분류 회의를 열어도 미분류 필터는 현재가 아니다", async () => {
    mockApi([...TREE_ROUTES, ...detailRoutes(9, {
      title: "분류 안 한 회의", category_id: null, category_name: null,
    })]);
    renderAt("/meetings/9");

    await screen.findByRole("heading", { name: "분류 안 한 회의" });
    const tree = await treeNav();
    // 미분류 unfolds to show it — the folder is where it is, not what is current.
    expect(await tree.findByRole("link", { name: "분류 안 한 회의" })).toHaveAttribute(
      "aria-current", "page",
    );
    expect(tree.getByRole("link", { name: /^미분류/ })).not.toHaveAttribute("aria-current");
    expect(tree.getByRole("link", { name: /^전체 회의/ })).not.toHaveAttribute("aria-current");
    expect(await currentTargets()).toEqual(["/meetings/9"]);
    expect(await wearingActiveSurface()).toHaveLength(0);
  });

  it("E. 다른 회의로 옮기면 선택도 따라 옮겨간다", async () => {
    mockApi([
      ...TREE_ROUTES,
      ...detailRoutes(7, { title: "지오영 테스트 음성파일", category_id: 3, category_name: "개발" }),
      ...detailRoutes(8, { title: "정산 후속 회의", category_id: 3, category_name: "개발" }),
    ]);
    renderAt("/meetings/7");

    const tree = await treeNav();
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(tree.getByRole("link", { name: "정산 후속 회의" }));

    await waitFor(() =>
      expect(tree.getByRole("link", { name: "정산 후속 회의" })).toHaveAttribute(
        "aria-current", "page",
      ),
    );
    expect(tree.getByRole("link", { name: "지오영 테스트 음성파일" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(await currentTargets()).toEqual(["/meetings/8"]);
  });

  it("F. 목록으로 되돌아가면 필터가 다시 현재가 된다", async () => {
    // The route is the single source: going back to a list hands 전체 회의 its
    // state back, and takes the meeting's away. Real history back/forward is
    // covered in the browser smoke, which has a real history stack.
    mockApi([...TREE_ROUTES, ...detailRoutes(7, {
      title: "지오영 테스트 음성파일", category_id: 3, category_name: "개발",
    })]);
    renderAt("/meetings/7");

    const tree = await treeNav();
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(tree.getByRole("link", { name: /^전체 회의/ }));

    await waitFor(() =>
      expect(tree.getByRole("link", { name: /^전체 회의/ })).toHaveAttribute(
        "aria-current", "page",
      ),
    );
    expect(tree.getByRole("link", { name: "지오영 테스트 음성파일" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(await currentTargets()).toEqual(["/"]);
  });
});

describe("사이드바에서 카테고리를 관리한다", () => {
  const created = (body: unknown): Route => ({
    method: "POST", path: "/api/meeting-categories", body,
  });

  it("카테고리가 없으면 무엇을 하면 되는지 알려준다", async () => {
    mockApi([AUTH_OK, MEETINGS, NO_CATEGORIES]);
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

/*
  Filing moved out of the meeting and onto the row.

  The detail page had an 내 정리 panel — an alias field and a category select —
  so arranging a list meant opening the things in it one at a time. Both are now
  on the `⋯` of every meeting row, in the sidebar tree and in the meeting list,
  through the same two dialogs and the same two endpoints.
*/
describe("사이드바 회의 행 메뉴", () => {
  const treeNav = async () =>
    within(await screen.findByRole("navigation", { name: "카테고리 탐색" }));

  /** One meeting in 업무 / 개발, mutable so a save can be observed landing. */
  function live(over: Record<string, unknown> = {}) {
    const state = { alias: null as string | null, category_id: 3 as number | null };
    const row = () =>
      meeting({
        id: 7, title: "지오영 테스트 음성파일", alias: state.alias,
        category_id: state.category_id,
        category_name: state.category_id === 3 ? "개발" : null,
        ...over,
      });
    const rows = [row()];
    const routes: Route[] = [
      AUTH_OK, CATEGORY_TREE, meetingsRoute(rows, CATEGORY_TREE_ROWS),
      {
        path: "/api/meetings/7",
        reply: () => ({
          body: meetingDetail({
            ...row(), speakers: [], segments: [], my_speaker_id: null, ...over,
          }),
        }),
      },
      sharesRoute(),
      { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
      { path: "/api/meetings/7/intelligence", body: { state: "READY", error: null, facts: [] } },
      {
        method: "PUT", path: "/api/meetings/7/alias",
        reply: (call) => {
          state.alias = (call.body as { alias: string | null }).alias;
          rows[0] = row();
          return { body: { id: 7, alias: state.alias, display_title: rows[0].display_title } };
        },
      },
      {
        method: "PUT", path: "/api/meetings/7/category",
        reply: (call) => {
          state.category_id = (call.body as { category_id: number | null }).category_id;
          rows[0] = row();
          return { body: { id: 7, category_id: state.category_id, category_name: null } };
        },
      },
    ];
    return routes;
  }

  const openTo = async (folder: string) => {
    const tree = await treeNav();
    await userEvent.click(await tree.findByRole("button", { name: `${folder} 펼치기` }));
    return tree;
  };

  it("한 회의는 트리에 정확히 한 번, 자기 카테고리 아래에만 나온다", async () => {
    /*
      The list endpoint reaches a folder's descendants, which is what a folder
      means on the list page. Asked that way, a meeting in 업무 / 개발 is a row
      under 개발 and another under 업무 — two links to one page, and on that page
      two rows marked current. The tree asks for `descendants=0` instead.
    */
    mockApi(live());
    renderAt("/");

    const tree = await openTo("업무");
    expect(await tree.findByRole("button", { name: "개발 펼치기" })).toBeInTheDocument();
    expect(tree.queryByRole("link", { name: "지오영 테스트 음성파일" })).not.toBeInTheDocument();

    await userEvent.click(tree.getByRole("button", { name: "개발 펼치기" }));
    expect(await tree.findAllByRole("link", { name: "지오영 테스트 음성파일" })).toHaveLength(1);
  });

  it("상세를 열어도 그 회의는 한 번만, 선택도 하나뿐이다", async () => {
    mockApi(live());
    renderAt("/meetings/7");

    const tree = await treeNav();
    const rows = await tree.findAllByRole("link", { name: "지오영 테스트 음성파일" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("aria-current", "page");
  });

  it("미분류 회의도 트리에 나오고 선택된다", async () => {
    mockApi(live({ category_id: null, category_name: null }));
    renderAt("/meetings/7");

    // 미분류 unfolds itself, because that is where the open meeting is filed.
    const tree = await treeNav();
    expect(await tree.findByRole("button", { name: "미분류 접기" })).toHaveAttribute(
      "aria-expanded", "true",
    );
    const rows = await tree.findAllByRole("link", { name: "지오영 테스트 음성파일" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("aria-current", "page");
  });

  it("행 메뉴를 열어도 그 회의로 이동하지 않는다", async () => {
    const calls = mockApi(live());
    renderAt("/");

    const tree = await openTo("업무");
    await userEvent.click(await tree.findByRole("button", { name: "개발 펼치기" }));
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );

    expect(await screen.findByRole("menuitem", { name: "이름 변경" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "카테고리 이동" })).toBeInTheDocument();
    /* The trigger sits over the row rather than inside the link, so opening it
       cannot navigate: the meeting's own page was never fetched. (The open menu
       is modal, so the page behind it is `aria-hidden` and cannot be queried by
       role — the request log is what says where we are.) */
    expect(calls.some((c) => c.url.endsWith("/api/meetings/7"))).toBe(false);
  });

  it("사이드바 행에서 내 회의를 삭제하면 회의가 지워지고 개수가 다시 읽힌다", async () => {
    const calls = mockApi([
      ...live(),
      { method: "DELETE", path: "/api/meetings/7", body: { id: 7, deleted: true } },
    ]);
    renderAt("/");

    const tree = await openTo("업무");
    await userEvent.click(await tree.findByRole("button", { name: "개발 펼치기" }));
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "이 회의를 삭제할까요?" })).toBeInTheDocument();
    const before = calls.filter((c) => c.url.includes("/api/meeting-categories")).length;
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/meetings/7"))).toBe(
        true,
      ),
    );
    // the counts beside 전체 회의 and 미분류 are read again rather than left
    // behind — the number the sidebar shows is the server's, not a subtraction.
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes("/api/meeting-categories")).length)
        .toBeGreaterThan(before),
    );
  });

  it("사이드바 행에서 공유받은 회의를 삭제하면 내 공유만 지운다", async () => {
    const calls = mockApi([
      ...live({ is_owner: false, owner_user_id: 99, owner_display_name: "최광훈" }),
      { method: "DELETE", path: "/api/meetings/7/shares/me", body: { meeting_id: 7, left: true } },
    ]);
    renderAt("/");

    const tree = await openTo("업무");
    await userEvent.click(await tree.findByRole("button", { name: "개발 펼치기" }));
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "공유받은 회의를 삭제할까요?" }),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/shares/me"))).toBe(true),
    );
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/meetings/7"))).toBe(
      false,
    );
  });

  it("사이드바에서 이름을 바꾸면 사이드바와 상세 제목이 함께 바뀐다", async () => {
    const calls = mockApi(live());
    renderAt("/meetings/7");

    const tree = await treeNav();
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "이름 변경" }));
    await userEvent.type(await screen.findByLabelText("내 표시 이름"), "정산 통화");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/alias"))?.body).toEqual({
        alias: "정산 통화",
      }),
    );
    // one mutation, one invalidation, both surfaces
    expect(await screen.findByRole("heading", { name: "정산 통화" })).toBeInTheDocument();
    expect(await tree.findByRole("link", { name: "정산 통화" })).toBeInTheDocument();
  });

  it("카테고리를 옮기면 트리에서 자리가 바뀐다", async () => {
    const calls = mockApi(live());
    renderAt("/meetings/7");

    const tree = await treeNav();
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "카테고리 이동" }));
    await userEvent.selectOptions(await screen.findByLabelText("카테고리"), "4");
    await userEvent.click(screen.getByRole("button", { name: "이동" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/category"))?.body).toEqual({
        category_id: 4,
      }),
    );
    // 운영 unfolds itself, because that is where the meeting is now filed…
    expect(await tree.findByRole("button", { name: "운영 접기" })).toHaveAttribute(
      "aria-expanded", "true",
    );
    // …and it is gone from 개발: still exactly one row, still the open meeting,
    // and the route never moved.
    await waitFor(async () =>
      expect(await tree.findAllByRole("link", { name: "지오영 테스트 음성파일" }))
        .toHaveLength(1),
    );
    const inOps = within(tree.getByRole("link", { name: /^운영/ }).closest("li")!);
    expect(inOps.getByRole("link", { name: "지오영 테스트 음성파일" })).toHaveAttribute(
      "aria-current", "page",
    );
    expect(
      within(tree.getByRole("link", { name: /^개발/ }).closest("li")!)
        .queryByRole("link", { name: "지오영 테스트 음성파일" }),
    ).not.toBeInTheDocument();
  });

  it("공유받은 회의도 같은 메뉴를 쓰고, 원래 이름은 그대로다", async () => {
    // The recipient writes their own filing row and nothing else — the request
    // carries an alias, never a title. tests/test_sharing.py holds the refusal.
    const calls = mockApi(live({ role: "SHARED_READ", is_owner: false, owner_display_name: "최광훈" }));
    renderAt("/meetings/7");

    const tree = await treeNav();
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "이름 변경" }));
    // the recording's own name is on the field, as the thing clearing goes back to
    expect(await screen.findByText(/원래 이름: 지오영 테스트 음성파일/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("내 표시 이름"), "정산 사례");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      const sent = calls.filter((c) => c.method === "PUT");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.endsWith("/alias")).toBe(true);
      expect(sent[0]!.body).toEqual({ alias: "정산 사례" });
    });
  });

  it("회의 상세에는 내 정리 편집 영역이 없다", async () => {
    mockApi(live());
    renderAt("/meetings/7?tab=overview");

    await screen.findByRole("heading", { name: "회의 정보" });
    expect(screen.queryByRole("heading", { name: "내 정리" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("내 표시 이름")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("카테고리")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "표시 이름 저장" })).not.toBeInTheDocument();
  });
});

/*
  전체 회의 and 미분류 are navigation rows like any folder, and until now they
  were the only ones with nothing in the count column. The number comes from the
  same response as the tree, counted by the server over the readable set — never
  from how many rows a page happened to load.
*/
describe("사이드바 개수", () => {
  const treeNav = async () =>
    within(await screen.findByRole("navigation", { name: "카테고리 탐색" }));

  it("전체 회의와 미분류가 폴더와 같은 자리에 개수를 쓴다", async () => {
    // 3 filed across the tree, 3 unfiled — the total is both halves.
    mockApi([AUTH_OK, meetingsRoute([]), categoryTree(CATEGORY_TREE_ROWS, { uncategorized: 3 })]);
    renderAt("/");

    /* Matched by prefix and read for its text: `dom-accessibility-api` joins
       adjacent element children without the separator a real browser inserts,
       which is why every count assertion in this file is written this way. */
    const tree = await treeNav();
    expect(await tree.findByRole("link", { name: /^전체 회의/ })).toHaveTextContent("6");
    expect(tree.getByRole("link", { name: /^미분류/ })).toHaveTextContent("3");
    // and the folders keep exactly the count they always had
    expect(tree.getByRole("link", { name: /^업무/ })).toHaveTextContent("1");
    expect(tree.getByRole("link", { name: "개인" })).toBeInTheDocument();
  });

  it("0건은 숫자를 그리지 않는다 — 빈 폴더와 같은 규칙이다", async () => {
    mockApi([AUTH_OK, meetingsRoute([]), categoryTree([])]);
    renderAt("/");

    const tree = await treeNav();
    // exact names: there is no number in either row
    expect(await tree.findByRole("link", { name: "전체 회의" })).toBeInTheDocument();
    expect(tree.getByRole("link", { name: "미분류" })).toBeInTheDocument();
  });

  it("100건이 넘으면 99+로 줄여 쓰고, 실제 개수는 행이 말해 준다", async () => {
    mockApi([AUTH_OK, meetingsRoute([]), categoryTree([], { total: 147, uncategorized: 147 })]);
    renderAt("/");

    const tree = await treeNav();
    const all = await tree.findByRole("link", { name: /^전체 회의/ });
    expect(all).toHaveTextContent("99+");
    // The one case where the screen hides the figure is the one case that says it.
    expect(within(all).getByTitle("전체 회의 147개")).toBeInTheDocument();
    expect(within(tree.getByRole("link", { name: /^미분류/ })).getByTitle("미분류 147개"))
      .toBeInTheDocument();
  });

  it("99건까지는 그대로 쓰고 제목을 덧붙이지 않는다", async () => {
    mockApi([AUTH_OK, meetingsRoute([]), categoryTree([], { total: 99, uncategorized: 0 })]);
    renderAt("/");

    const tree = await treeNav();
    const all = await tree.findByRole("link", { name: /^전체 회의/ });
    expect(all).toHaveTextContent("99");
    // No duplicate announcement while the number is already on screen.
    expect(within(all).queryByTitle(/전체 회의/)).not.toBeInTheDocument();
  });

  it("개수는 현재 위치 표시를 건드리지 않는다", async () => {
    mockApi([AUTH_OK, meetingsRoute([]), categoryTree(CATEGORY_TREE_ROWS, { uncategorized: 3 })]);
    renderAt("/");

    const tree = await treeNav();
    const all = await tree.findByRole("link", { name: /^전체 회의/ });
    expect(all).toHaveTextContent("6");
    expect(all).toHaveAttribute("aria-current", "page");
    expect(tree.getByRole("link", { name: /^미분류/ })).not.toHaveAttribute("aria-current");
    // exactly one row is current, and it is the one the route names
    expect(
      tree.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
  });

  it("회의를 폴더로 옮기면 미분류에서 빠지고 전체는 그대로다", async () => {
    const state = { filed: null as number | null };
    const rows = [meeting({
      id: 7, title: "지오영 테스트 음성파일", category_id: null, category_name: null,
    })];
    const counts = () => ({
      categories: CATEGORY_TREE_ROWS.map((k) => ({
        ...k, meeting_count: k.id === state.filed ? 1 : 0,
      })),
      total: 1,
      uncategorized: state.filed === null ? 1 : 0,
    });
    const calls = mockApi([
      AUTH_OK,
      { path: "/api/meeting-categories", reply: () => ({ body: counts() }) },
      meetingsRoute(rows, CATEGORY_TREE_ROWS),
      {
        method: "PUT", path: "/api/meetings/7/category",
        reply: (call) => {
          state.filed = (call.body as { category_id: number | null }).category_id;
          rows[0] = meeting({
            id: 7, title: "지오영 테스트 음성파일",
            category_id: state.filed, category_name: "개인",
          });
          return { body: { id: 7, category_id: state.filed, category_name: "개인" } };
        },
      },
    ]);
    renderAt("/");

    const tree = await treeNav();
    await waitFor(() =>
      expect(tree.getByRole("link", { name: /^미분류/ })).toHaveTextContent("1"),
    );

    await userEvent.click(tree.getByRole("button", { name: "미분류 펼치기" }));
    await tree.findByRole("link", { name: "지오영 테스트 음성파일" });
    await userEvent.click(
      tree.getByRole("button", { name: "지오영 테스트 음성파일 관리 메뉴" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "카테고리 이동" }));
    await userEvent.selectOptions(await screen.findByLabelText("카테고리"), "1");
    await userEvent.click(screen.getByRole("button", { name: "이동" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ category_id: 1 }),
    );
    // 미분류 loses its number, 개인 gains one, and 전체 회의 never moved: filing
    // is where a meeting sits, not whether it exists.
    await waitFor(() =>
      expect(tree.getByRole("link", { name: /^개인/ })).toHaveTextContent("1"),
    );
    expect(tree.getByRole("link", { name: "미분류" })).toBeInTheDocument();   // no number
    expect(tree.getByRole("link", { name: /^전체 회의/ })).toHaveTextContent("1");
  });
});
