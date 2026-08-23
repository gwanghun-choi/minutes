import { expect, test, type Page } from "@playwright/test";

const ME = { id: 1, username: "tester", display_name: "테스터" };

interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  depth: number;
  meeting_count: number;
  chat_count: number;
  child_count: number;
}

/**
 * A tree: 업무 / (개발, 고객 미팅). Path order, as the server returns it.
 *
 * A template, never the array a test talks to. `stubApi` copies it per test,
 * because the category stub genuinely mutates its tree — one test deletes 개발 —
 * and a shared array made every later test in the same worker run against a tree
 * a previous test had edited.
 */
const CATEGORIES: readonly Category[] = [
  { id: 3, name: "업무", parent_id: null, path: "업무", depth: 0, meeting_count: 0, chat_count: 0, child_count: 2 },
  { id: 1, name: "개발", parent_id: 3, path: "업무 / 개발", depth: 1, meeting_count: 1, chat_count: 0, child_count: 0 },
  { id: 2, name: "고객 미팅", parent_id: 3, path: "업무 / 고객 미팅", depth: 1, meeting_count: 1, chat_count: 0, child_count: 0 },
];

const MEETING = {
  id: 7, title: "8월 3주차 개발 회의", original_filename: "weekly.m4a",
  stored_filename: "abc.m4a", duration: 1830, language: "ko", status: "COMPLETED",
  error_message: null, created_at: "2026-08-20T01:00:00+00:00",
  held_at: "2026-08-19T01:00:00+00:00", occurred_at: "2026-08-19T01:00:00+00:00",
  category_id: 1, category_name: "개발", category_parent_id: 3,
  alias: null, display_title: "8월 3주차 개발 회의",
  intelligence_state: "READY", intelligence_error: null, speaker_count: 2,
  owner_user_id: ME.id, owner_display_name: ME.display_name, is_owner: true,
  active_version: 1, version_published_at: "2026-08-20T02:00:00+00:00",
};
const OTHER = {
  ...MEETING, id: 8, title: "기획 리뷰", display_title: "기획 리뷰",
  category_id: 2, category_name: "고객 미팅",
  held_at: "2026-08-18T01:00:00+00:00", occurred_at: "2026-08-18T01:00:00+00:00",
};

/**
 * The list endpoint, narrowed and paged by the server.
 *
 * The stub reads the parameters for the same reason the server does: a fixed
 * body could no longer tell a filtered request from an unfiltered one.
 */
function listMeetings(url: URL, rows: typeof MEETING[], categories: Category[]) {
  const p = url.searchParams;
  const q = (p.get("q") ?? "").toLowerCase();
  const category = p.get("category") ?? "";
  const status = p.get("status") ?? "";
  const size = Number(p.get("page_size")) || 20;
  const page = Number(p.get("page")) || 1;
  // A parent id reaches its children, which is the whole point of the tree —
  // unless the caller says otherwise. `descendants=0` is the sidebar asking for
  // the meetings filed in exactly this folder, because it draws the folders.
  const deep = p.get("descendants") !== "0";
  const inSubtree = (id: number | null) => {
    if (!category || category === "none") return true;
    const wanted = Number(category);
    if (!deep) return id === wanted;
    let at = categories.find((k) => k.id === id) ?? null;
    while (at) {
      if (at.id === wanted) return true;
      at = categories.find((k) => k.id === at!.parent_id) ?? null;
    }
    return false;
  };
  const items = rows.filter((m) => {
    if (q && !`${m.title} ${m.original_filename}`.toLowerCase().includes(q)) return false;
    if (status && m.status !== status) return false;
    if (category === "none" && m.category_id !== null) return false;
    if (!inSubtree(m.category_id)) return false;
    return true;
  });
  const order = p.get("sort") === "held_asc" ? 1 : -1;
  items.sort(
    (a, b) => order * (new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()),
  );
  return {
    items: items.slice((page - 1) * size, page * size),
    total: items.length,
    page,
    page_size: size,
  };
}

const SESSION = {
  id: 3, title: "비밀번호 전달 방법", scope_meeting_ids: [] as number[], category_id: null,
  updated_at: "2026-08-21T00:00:00Z",
};

/** The rename tests need the server to actually remember the new name. */
type State = {
  signedIn: boolean;
  scope: number[];
  withMessages?: boolean;
  /** The answer carries [1]…[6] citation markers. */
  cited?: boolean;
  title?: string;
};

/** Six sources, the shape a Top-K answer over both retrieval layers returns. */
const SOURCES = Array.from({ length: 6 }, (_, i) => ({
  index: i + 1, kind: "chunk", meeting_id: 7, meeting_title: "8월 3주차 개발 회의",
  speakers: ["화자 A"], start_time: i * 10, end_time: i * 10 + 9,
  time_label: `00:${String(i * 10).padStart(2, "0")} ~ 00:${String(i * 10 + 9).padStart(2, "0")}`,
  text: `근거 본문 ${i + 1}번입니다.`, score: 0.5 - i * 0.01, chunk_id: 100 + i,
}));

/** One API stub for the whole app, installed in the browser. */
async function stubApi(page: Page, state: State) {
  state.title ??= SESSION.title;
  // This test's own tree. The handlers below add to it, rename in it, and delete
  // from it, so it cannot be the module-level template.
  const categories: Category[] = CATEGORIES.map((k) => ({ ...k }));
  // Same reason as the tree: filing a meeting writes to it, so the two rows are
  // this test's own and not the module's.
  const meetings = [{ ...MEETING }, { ...OTHER }];
  const seven = () => meetings[0]!;
  const json = (body: unknown, status = 200) => ({
    status, contentType: "application/json", body: JSON.stringify(body),
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === "/api/auth/me") {
      return route.fulfill(
        state.signedIn ? json(ME) : json({ detail: "로그인이 필요합니다." }, 401),
      );
    }
    if (path === "/api/auth/login" && method === "POST") {
      state.signedIn = true;
      return route.fulfill(json({ username: ME.username, display_name: ME.display_name }));
    }
    if (path === "/api/meeting-categories" && method === "GET") {
      /* The sidebar's whole navigation in one response. 전체 회의 and 미분류 are
         derived from the same rows the list endpoint pages over, so a filing
         that moves a meeting moves the counts with it — which is the thing the
         browser has to be seen doing. */
      return route.fulfill(json({
        categories,
        total: meetings.length,
        uncategorized: meetings.filter((m) => m.category_id === null).length,
      }));
    }
    if (path === "/api/meetings" && method === "GET") {
      return route.fulfill(json(listMeetings(url, meetings, categories)));
    }
    if (path === "/api/meetings/7" && method === "DELETE") {
      return route.fulfill(json({ id: 7, deleted: true }));
    }
    if (path === "/api/meetings/7" && method === "GET") {
      return route.fulfill(json({
        meeting: seven(),
        speakers: [
          { id: 11, speaker_code: "SPEAKER_00", display_name: "화자 A" },
          { id: 12, speaker_code: "SPEAKER_01", display_name: "화자 B" },
        ],
        segments: [
          { sequence: 0, start_time: 0, end_time: 4, speaker_code: "SPEAKER_01",
            display_name: "화자 B", text: "현관 비밀번호 남겨주시면 감사하겠습니다." },
          { sequence: 1, start_time: 5, end_time: 9, speaker_code: "SPEAKER_00",
            display_name: "화자 A", text: "네, 통화 종료하고 문자로 남겨드리겠습니다." },
        ],
        my_speaker_id: 11,
        role: "OWNER",
        version: 1,
        active_version: 1,
        draft_version: null,
        shared_with: 0,
      }));
    }
    if (path === "/api/meetings/7/versions" && method === "GET") {
      return route.fulfill(json({
        active_version: 1,
        versions: [{
          version: 1, status: "PUBLISHED", created_at: "2026-08-20T01:00:00+00:00",
          published_at: "2026-08-20T02:00:00+00:00", created_by: ME.display_name,
          segment_count: 2,
        }],
      }));
    }
    if (path === "/api/meetings/7/shares" && method === "GET") {
      return route.fulfill(json([]));
    }
    // The sidebar asks for this on every screen.
    if (path === "/api/share-invitations" && method === "GET") {
      return route.fulfill(json([]));
    }
    if (path === "/api/meetings/7/category" && method === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const found = categories.find((k) => k.id === body.category_id);
      // The filing row the server would have written, so the next list and the
      // next detail agree with each other about where this meeting is.
      seven().category_id = body.category_id;
      seven().category_name = found?.name ?? null;
      seven().category_parent_id = found?.parent_id ?? null;
      return route.fulfill(json({
        id: 7, category_id: body.category_id, category_name: found?.name ?? null,
      }));
    }
    if (path === "/api/meetings/7/alias" && method === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      seven().alias = body.alias;
      seven().display_title = body.alias ?? seven().title;
      return route.fulfill(json({
        id: 7, alias: seven().alias, display_title: seven().display_title,
      }));
    }
    if (path === "/api/meetings/7/summary") {
      return route.fulfill(json({ meeting_id: 7, content: "핵심 요약\n- 문자로 전달" }));
    }
    if (path === "/api/meetings/7/intelligence") {
      return route.fulfill(json({
        state: "READY", error: null,
        facts: [{
          id: 102, fact_type: "ACTION_ITEM",
          content: "통화 종료 후 현관 비밀번호를 문자로 전달", status: "UNKNOWN",
          deadline_text: null, deadline_at: null, start_time: 5, end_time: 9,
          source_segment_ids: [2],
          source_text: "[화자 A] 네, 통화 종료하고 문자로 남겨드리겠습니다.",
          participants: { ASSIGNEE: "화자 A" },
        }],
      }));
    }
    if (path === "/api/meeting-categories" && method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const parent = categories.find((k) => k.id === body.parent_id) ?? null;
      const row: Category = {
        id: 99, name: body.name, parent_id: parent?.id ?? null,
        path: parent ? `${parent.path} / ${body.name}` : body.name,
        depth: parent ? parent.depth + 1 : 0, meeting_count: 0, chat_count: 0, child_count: 0,
      };
      if (parent) parent.child_count += 1;
      categories.push(row);
      return route.fulfill(json(row));
    }
    if (path.endsWith("/parent") && method === "PUT") {
      const id = Number(path.split("/").at(-2));
      const body = JSON.parse(route.request().postData() ?? "{}");
      const row = categories.find((k) => k.id === id)!;
      const parent = categories.find((k) => k.id === body.parent_id) ?? null;
      row.parent_id = parent?.id ?? null;
      row.path = parent ? `${parent.path} / ${row.name}` : row.name;
      row.depth = parent ? parent.depth + 1 : 0;
      return route.fulfill(json(row));
    }
    if (path.startsWith("/api/meeting-categories/") && method === "PATCH") {
      const id = Number(path.split("/").pop());
      const body = JSON.parse(route.request().postData() ?? "{}");
      const row = categories.find((k) => k.id === id)!;
      row.name = body.name;
      return route.fulfill(json(row));
    }
    if (path.startsWith("/api/meeting-categories/") && method === "DELETE") {
      const id = Number(path.split("/").pop());
      categories.splice(categories.findIndex((k) => k.id === id), 1);
      return route.fulfill(json({ id, deleted: true }));
    }
    if (path === "/api/chat/sessions" && method === "GET") {
      return route.fulfill(json([
        { ...SESSION, title: state.title, scope_meeting_ids: state.scope },
      ]));
    }
    if (path === "/api/chat/sessions/3/title" && method === "PATCH") {
      state.title = JSON.parse(route.request().postData() ?? "{}").title;
      return route.fulfill(json({ ...SESSION, title: state.title }));
    }
    if (path === "/api/chat/sessions/3" && method === "GET") {
      // Six candidates were retrieved either way. What the answer *cited* is the
      // second list, and the server derives it from the [N] in the answer — see
      // `rag.cited_sources`. This stub does the same, so the browser sees a
      // shape the API can actually produce.
      const content = state.cited
        ? "정리하면 다음과 같습니다. [1][3]"
        : "정리하면 다음과 같습니다.";
      const cited = new Set(
        [...content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
      );
      return route.fulfill(json({
        session: { ...SESSION, title: state.title, scope_meeting_ids: state.scope },
        messages: state.withMessages
          ? [
              { role: "user", content: "배포 일정은?", sources: [], cited_sources: [] },
              {
                role: "assistant",
                content,
                sources: SOURCES,
                cited_sources: SOURCES.filter((s) => cited.has(s.index)),
              },
            ]
          : [],
      }));
    }
    if (path === "/api/chat/sessions/3" && method === "PATCH") {
      state.scope = JSON.parse(route.request().postData() ?? "{}").scope_meeting_ids;
      return route.fulfill(json({ ...SESSION, scope_meeting_ids: state.scope }));
    }
    return route.fulfill(json({ detail: `unstubbed ${method} ${path}` }, 501));
  });
}

test("로그인 → 회의 목록 → 회의 상세 → 채팅 → 검색 범위", async ({ page }) => {
  const state = { signedIn: false, scope: [] as number[] };
  await stubApi(page, state);

  // A deep link while signed out lands on login and remembers where it was going.
  await page.goto("/meetings/7");
  await page.getByLabel("아이디").fill("tester");
  await page.getByLabel("비밀번호").fill("pw");
  await page.getByRole("button", { name: "로그인" }).click();

  await expect(page.getByRole("heading", { name: /8월 3주차 개발 회의/ })).toBeVisible();
  await expect(page.getByText("30:30")).toBeVisible();

  await page.getByRole("tab", { name: "인사이트" }).click();
  await expect(page.getByText("통화 종료 후 현관 비밀번호를 문자로 전달")).toBeVisible();
  await page.getByRole("button", { name: /원문 1개 발화/ }).click();
  await expect(page.getByText(/문자로 남겨드리겠습니다/)).toBeVisible();

  await page.getByRole("link", { name: "회의", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "회의", exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByText("기획 리뷰")).toBeVisible();

  await page.getByRole("link", { name: "채팅", exact: true }).click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByLabel("현재 검색 범위")).toHaveText("접근 가능한 전체 회의");
});

test("대화 목록은 앱 사이드바 안에 있고, 대화 입력창은 가운데 열에 맞는다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [], withMessages: true });
  await page.goto("/chat/3");

  // One sidebar: the nav and the conversation list share it. By name, not by
  // tag — the 출처 panel is an <aside> too and is always mounted, so counting
  // tags passed only while the conversation was still loading.
  const sidebar = page.getByRole("complementary", { name: "사이드바" });
  await expect(sidebar).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: "채팅", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "비밀번호 전달 방법", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "새 채팅" })).toBeVisible();

  // The composer sits on the conversation's axis, not across the whole window.
  const composer = page.getByLabel("질문", { exact: true });
  const box = (await composer.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBeLessThan(viewport.width * 0.7);
});

test("출처가 없는 답변에는 출처 버튼이 없다", async ({ page }) => {
  // Six candidates were retrieved and the answer quoted none of them. Offering
  // them as 출처 would present a search result as evidence for a claim.
  await stubApi(page, { signedIn: true, scope: [], withMessages: true });
  await page.goto("/chat/3");

  await expect(page.getByText("정리하면 다음과 같습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: /출처 \d+개/ })).toHaveCount(0);
});

test("출처는 기본으로 닫혀 있고, 오른쪽에서 밀려 들어왔다 다시 나간다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [], withMessages: true, cited: true });
  await page.goto("/chat/3");

  // The answer is on screen; none of its evidence is, only the count — and the
  // count is what the answer cited, not what the search found.
  await expect(page.getByText(/정리하면 다음과 같습니다/)).toBeVisible();
  const toggle = page.getByRole("button", { name: "출처 2개" });
  await expect(toggle).toBeVisible();
  await expect(page.getByRole("complementary", { name: "출처" })).toHaveCount(0);

  // Where the answer sits before the drawer exists on screen. It must not move:
  // the drawer is an overlay, so the reading column keeps its measure and its
  // centre axis.
  const answer = page.getByText(/정리하면 다음과 같습니다/);
  const before = (await answer.boundingBox())!;

  await toggle.click();
  const panel = page.getByRole("complementary", { name: "출처" });
  await expect(panel.getByText("근거 본문 1번입니다.")).toBeVisible();
  await expect(panel.getByText("근거 본문 3번입니다.")).toBeVisible();
  // …and only those two. The other four were retrieved, not quoted.
  await expect(panel.getByText("근거 본문 6번입니다.")).toHaveCount(0);

  // It slides in from the right edge and stops flush against it. Polled, because
  // it is a transition rather than an appearance — which is the point.
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = (await panel.boundingBox())!;
      return Math.round(box.x + box.width);
    })
    .toBe(viewport.width);
  expect(await answer.boundingBox()).toEqual(before);

  // The same button closes what it opened.
  await toggle.click();
  await expect(page.getByRole("complementary", { name: "출처" })).toHaveCount(0);
  await expect(toggle).toBeVisible();
});

test("답변의 [3] 인용을 누르면 그 출처가 열린다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [], withMessages: true, cited: true });
  await page.goto("/chat/3");

  await page.getByRole("button", { name: "출처 3 보기" }).click();
  const panel = page.getByRole("complementary", { name: "출처" });
  await expect(panel.getByText("근거 본문 3번입니다.")).toBeVisible();
  // The answer's other citation is here too — the panel is one answer's
  // evidence, not one card.
  await expect(panel.getByText("근거 본문 1번입니다.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("회의 목록은 페이지로 나뉘고 다음 페이지로 넘어간다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings?size=20");

  await expect(page.getByText("총 2개 중 1–2")).toBeVisible();
  await page.getByLabel("페이지당 개수").selectOption("50");
  await expect(page.getByText("총 2개 중 1–2")).toBeVisible();
  await expect(page.getByRole("button", { name: "다음 페이지" })).toBeDisabled();
});

test("사이드바 카테고리 트리에서 상위를 고르면 하위 회의까지 나온다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings");

  const sidebar = page.getByRole("complementary", { name: "사이드바" });
  const table = page.getByRole("table");
  await sidebar.getByRole("button", { name: "업무 펼치기" }).click();
  // By its rendered path: expanding also lists the meetings inside it, and
  // "개발" is in one of their names too.
  await sidebar.getByTitle("업무 / 개발").click();
  await expect(table.getByText("8월 3주차 개발 회의")).toBeVisible();
  await expect(table.getByText("기획 리뷰")).toHaveCount(0);

  // The parent reaches both children.
  await sidebar.getByRole("link", { name: /^업무/ }).click();
  await expect(table.getByText("8월 3주차 개발 회의")).toBeVisible();
  await expect(table.getByText("기획 리뷰")).toBeVisible();

  await sidebar.getByRole("link", { name: /^미분류/ }).click();
  await expect(page.getByText("조건에 맞는 회의가 없습니다.")).toBeVisible();
});

/*
  The sidebar answers "which list am I looking at" and "which meeting do I have
  open" separately, and a real history stack is the only place back/forward can
  be checked. Both used to be one grey: on a meeting page 전체 회의 stayed lit
  beside the meeting, because "no ?category" and "not on a list" were one value.
*/
test("사이드바는 보고 있는 목록과 열어 둔 회의를 따로 표시한다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  const tree = page.getByRole("navigation", { name: "카테고리 탐색" });
  const current = tree.locator('a[aria-current="page"]');
  /* One rule, instead of a count: every row marked current points at the URL you
     are on. A meeting can legitimately appear twice — the list endpoint reaches
     a folder's descendants, so it is under 업무 as well as 업무 / 개발 — and both
     of those rows are the page you are on. A filter row never is. */
  const currentTargets = async () => [
    ...new Set(await current.evaluateAll((els) => els.map((e) => e.getAttribute("href")))),
  ];

  // A. the whole list
  await page.goto("/meetings");
  await expect(current).toHaveCount(1);
  expect(await currentTargets()).toEqual(["/"]);

  // B. one category's list
  await tree.getByRole("link", { name: /^업무/ }).click();
  await expect(page).toHaveURL(/category=3/);
  await expect(current).toHaveCount(1);
  expect(await currentTargets()).toEqual(["/?category=3"]);

  // C. one meeting's page. 업무 has never been unfolded by hand in this test, so
  // 접기 being offered below is the tree opening itself down to the meeting.
  await page.goto("/meetings/7");
  await expect(tree.getByRole("button", { name: "업무 접기" })).toHaveAttribute(
    "aria-expanded", "true",
  );
  await expect.poll(currentTargets).toEqual(["/meetings/7"]);
  await expect(tree.getByRole("link", { name: /^전체 회의/ })).not.toHaveAttribute("aria-current");

  // F. back and forward, on a real history stack
  await page.goBack();
  await expect(page).toHaveURL(/category=3/);
  await expect.poll(currentTargets).toEqual(["/?category=3"]);

  await page.goForward();
  await expect(page).toHaveURL(/\/meetings\/7$/);
  await expect.poll(currentTargets).toEqual(["/meetings/7"]);
});

test("멈춘 화자 분리 회의를 상세에서 삭제한다", async ({ page }) => {
  const state = { signedIn: true, scope: [] as number[] };
  await stubApi(page, state);
  // The server restarted: the row still says DIARIZING and no task is running.
  await page.route("**/api/meetings/7", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        meeting: {
          ...MEETING, status: "DIARIZING", intelligence_state: "NOT_BUILT",
          active_version: null, version_published_at: null,
        },
        speakers: [], segments: [], my_speaker_id: null,
        role: "OWNER", version: 1, active_version: null, draft_version: 1,
        shared_with: 0,
      }),
    });
  });

  await page.goto("/meetings/7?tab=overview");
  await expect(page.getByText(/서버가 재시작된 뒤라면/)).toBeVisible();
  await page.getByRole("button", { name: "회의 삭제" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/아무것도 저장하지 못한 채 끝납니다/)).toBeVisible();
  await dialog.getByRole("button", { name: "삭제" }).click();

  // Back on the list, which is where a deleted meeting leaves you.
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "회의", exact: true })).toBeVisible();
});

test("채팅 세션 이름을 바꾸면 사이드바와 제목에 남고 새로고침해도 유지된다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [], withMessages: true });
  await page.goto("/chat/3");

  const sidebar = page.getByRole("complementary", { name: "사이드바" });
  await expect(page.getByRole("heading", { name: "비밀번호 전달 방법" })).toBeVisible();

  await sidebar.getByRole("button", { name: "비밀번호 전달 방법 대화 메뉴" }).click();
  await page.getByRole("menuitem", { name: "이름 변경" }).click();

  const field = page.getByLabel("대화 이름");
  await field.fill("현관 비밀번호 전달");
  await field.press("Enter");

  await expect(sidebar.getByRole("button", { name: "현관 비밀번호 전달", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "현관 비밀번호 전달" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "현관 비밀번호 전달" })).toBeVisible();
});

test("카테고리는 사이드바에서 만들고 지운다", async ({ page }) => {
  // Managing categories used to mean leaving the list to organise the list.
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings");

  await expect(page.getByRole("link", { name: "카테고리 관리" })).toHaveCount(0);
  const sidebar = page.getByRole("complementary", { name: "사이드바" });
  // The tree is legible as a tree: the child carries its parent in its path.
  await sidebar.getByRole("button", { name: "업무 펼치기" }).click();
  await expect(sidebar.getByTitle("업무 / 개발")).toBeVisible();

  await sidebar.getByRole("button", { name: "새 카테고리" }).click();
  await page.getByLabel("이름").fill("내부 업무");
  await page.getByLabel("상위 카테고리").selectOption({ label: "업무" });
  await page.getByRole("button", { name: "추가" }).click();
  await expect(sidebar.getByTitle("업무 / 내부 업무")).toBeVisible();

  // Deleting a folder says what happens to what was in it, before it happens.
  await sidebar.getByRole("button", { name: "개발 카테고리 메뉴" }).click();
  await page.getByRole("menuitem", { name: "삭제" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/폴더만 사라집니다/)).toBeVisible();
  await dialog.getByRole("button", { name: "삭제" }).click();
  await expect(sidebar.getByTitle("업무 / 개발")).toHaveCount(0);
});

test("승인 전 개요는 빈 카드가 아니라 다음에 할 일을 보여준다", async ({ page }) => {
  const state = { signedIn: true, scope: [] as number[] };
  await stubApi(page, state);
  // Same meeting, still waiting on review.
  await page.route("**/api/meetings/7", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        meeting: {
          ...MEETING, status: "REVIEW_REQUIRED", intelligence_state: "NOT_BUILT",
          active_version: null, version_published_at: null,
        },
        speakers: [{ id: 11, speaker_code: "SPEAKER_00", display_name: "화자 A" }],
        segments: [{ sequence: 0, start_time: 0, end_time: 4, speaker_code: "SPEAKER_00",
          display_name: "화자 A", text: "확인해 보겠습니다." }],
        my_speaker_id: null,
        // Nothing published yet, version 1 open: the state the review gate is.
        role: "OWNER", version: 1, active_version: null, draft_version: 1,
        shared_with: 0,
      }),
    });
  });

  await page.goto("/meetings/7?tab=overview");
  await expect(page.getByText("아직 생성된 요약이 없습니다.")).toBeVisible();
  await expect(page.getByText("현재 상태")).toBeVisible();
  await expect(page.getByText("회의록 탭에서 초안 검토")).toBeVisible();

  await page.getByRole("button", { name: "회의록 검토하기" }).click();
  await expect(page.getByLabel("발화 0 내용")).toBeVisible();
});

test("검색 범위 대화상자는 ESC로 닫히고, 검색·카테고리로 좁혀 여러 회의를 고른다", async ({ page }) => {
  const state = { signedIn: true, scope: [] as number[] };
  await stubApi(page, state);

  await page.goto("/chat/3");
  await page.getByRole("button", { name: "범위 변경" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Focus really is trapped in the dialog, which is why ESC is meaningful.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "범위 변경" }).click();
  await dialog.getByLabel("카테고리로 거르기").selectOption("2");
  await expect(dialog.getByText("기획 리뷰")).toBeVisible();
  await expect(dialog.getByText("8월 3주차 개발 회의")).toHaveCount(0);

  await dialog.getByLabel("카테고리로 거르기").selectOption("");
  await dialog.getByLabel("회의명 검색").fill("기획");
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await dialog.getByLabel("회의명 검색").fill("");

  await dialog.getByRole("checkbox").nth(0).check();
  await dialog.getByRole("checkbox").nth(1).check();
  await expect(dialog.getByText("2개 선택됨")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "선택한 회의" })).toHaveAttribute(
    "aria-checked", "true",
  );
  await dialog.getByRole("button", { name: "선택 완료" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("현재 검색 범위")).toHaveText("선택한 회의 2개");
  expect(state.scope).toEqual([7, 8]);
});

test("회의 목록은 검색·카테고리·상태로 좁히고 필터를 되돌릴 수 있다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings");

  const table = page.getByRole("table");
  // The option label is the full path now: 업무 / 고객 미팅.
  await page.getByLabel("카테고리로 거르기").selectOption("2");
  await expect(table.getByText("기획 리뷰")).toBeVisible();
  await expect(table.getByText("8월 3주차 개발 회의")).toHaveCount(0);

  await page.getByLabel("회의 검색").fill("없는회의");
  await expect(page.getByText("조건에 맞는 회의가 없습니다.")).toBeVisible();

  await page.getByRole("button", { name: "필터 초기화" }).first().click();
  await expect(table.getByText("8월 3주차 개발 회의")).toBeVisible();

  await page.getByLabel("상태로 거르기").selectOption("REVIEW_REQUIRED");
  await expect(page.getByText("조건에 맞는 회의가 없습니다.")).toBeVisible();
});

/*
  Filing, from the row rather than from inside the meeting.

  The detail page used to carry an 내 정리 panel — an alias field and a category
  select — so arranging a list meant opening its items one at a time. Both now
  hang off the `⋯` on the row, in the tree and in the list, through the same
  dialogs and the same two endpoints.
*/
test("사이드바 회의 행에서 이름을 바꾸고 카테고리를 옮긴다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  const tree = page.getByRole("navigation", { name: "카테고리 탐색" });
  const current = tree.locator('a[aria-current="page"]');
  await page.goto("/meetings/7");

  // 1–2. the tree unfolds down to the meeting, and draws it once — under 개발,
  // which is where it is filed, and not again under its parent 업무.
  await expect(tree.getByRole("button", { name: "업무 접기" })).toBeVisible();
  const row = tree.getByRole("link", { name: "8월 3주차 개발 회의" });
  await expect(row).toHaveCount(1);
  // 8. …and that one row is the only thing marked current
  await expect(current).toHaveCount(1);

  // 3. the ⋯ is quiet until the row is hovered — this one is the open meeting,
  // so it is already visible; hovering a different row reveals that row's.
  const menu = tree.getByRole("button", { name: "8월 3주차 개발 회의 관리 메뉴" });
  await expect(menu).toBeVisible();
  await tree.getByRole("button", { name: "고객 미팅 펼치기" }).click();
  const other = tree.getByRole("button", { name: "기획 리뷰 관리 메뉴" });
  await expect(other).toHaveCSS("opacity", "0");
  await tree.getByRole("link", { name: "기획 리뷰" }).hover();
  await expect(other).toHaveCSS("opacity", "1");

  // 4–5. rename from the sidebar; the sidebar row and the page title both move
  await menu.click();
  await page.getByRole("menuitem", { name: "이름 변경" }).click();
  await page.getByLabel("내 표시 이름").fill("정산 통화");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("heading", { name: "정산 통화" })).toBeVisible();
  await expect(tree.getByRole("link", { name: "정산 통화" })).toBeVisible();
  await expect(page).toHaveURL(/\/meetings\/7$/);

  // 6–7. move it, and the row moves with it — out of 개발, into 고객 미팅,
  // still exactly one row and still the meeting you have open
  await tree.getByRole("button", { name: "정산 통화 관리 메뉴" }).click();
  await page.getByRole("menuitem", { name: "카테고리 이동" }).click();
  await page.getByRole("combobox", { name: "카테고리" }).selectOption("2");
  await page.getByRole("button", { name: "이동" }).click();

  await expect(tree.getByRole("button", { name: "고객 미팅 접기" })).toBeVisible();
  const moved = tree.getByRole("link", { name: "정산 통화" });
  await expect(moved).toHaveCount(1);
  await expect(moved).toHaveAttribute("aria-current", "page");
  await expect(
    tree.getByRole("link", { name: /^개발/ }).locator("xpath=../..")
      .getByRole("link", { name: "정산 통화" }),
  ).toHaveCount(0);
  await expect(current).toHaveCount(1);
});

test("미분류 회의도 트리에서 열리고 정리할 수 있다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  const tree = page.getByRole("navigation", { name: "카테고리 탐색" });
  await page.goto("/meetings/7");

  // out of every folder…
  await tree.getByRole("button", { name: "8월 3주차 개발 회의 관리 메뉴" }).click();
  await page.getByRole("menuitem", { name: "카테고리 이동" }).click();
  await page.getByRole("combobox", { name: "카테고리" }).selectOption("");
  await page.getByRole("button", { name: "이동" }).click();

  // …and 미분류 is a folder like the rest: it unfolds and holds the meeting,
  // which is still the one selected.
  await expect(tree.getByRole("button", { name: "미분류 접기" })).toHaveAttribute(
    "aria-expanded", "true",
  );
  const row = tree.getByRole("link", { name: "8월 3주차 개발 회의" });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-current", "page");
});

/*
  전체 회의 and 미분류 were the only navigation rows with nothing in the count
  column. Both now carry one, counted by the server over the readable set — so a
  filing that moves a meeting between them moves the numbers, and the total,
  which is about how many meetings exist rather than where they sit, does not.
*/
test("사이드바 전체 회의와 미분류 개수가 정리에 따라 움직인다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  const tree = page.getByRole("navigation", { name: "카테고리 탐색" });
  const all = tree.getByRole("link", { name: /^전체 회의/ });
  const unfiled = tree.getByRole("link", { name: /^미분류/ });
  await page.goto("/meetings/7");

  // Two meetings, both filed. 미분류 shows no number at all, like an empty folder.
  await expect(all).toContainText("2");
  await expect(unfiled).toHaveText("미분류");
  await expect(tree.getByRole("link", { name: /^개발/ })).toContainText("1");

  await tree.getByRole("button", { name: "8월 3주차 개발 회의 관리 메뉴" }).click();
  await page.getByRole("menuitem", { name: "카테고리 이동" }).click();
  await page.getByRole("combobox", { name: "카테고리" }).selectOption("");
  await page.getByRole("button", { name: "이동" }).click();

  await expect(unfiled).toContainText("1");
  await expect(all).toContainText("2");        // unmoved: nothing was created or deleted
  // A count is metadata on a row, not a control. No list is on screen, so no
  // filter row is current — before the move or after it — and the route did not
  // move either.
  await expect(all).not.toHaveAttribute("aria-current", "page");
  await expect(unfiled).not.toHaveAttribute("aria-current", "page");
  await expect(tree.getByRole("link", { name: "8월 3주차 개발 회의" }))
    .toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/\/meetings\/7$/);
});

test("회의 상세에는 내 정리 편집 영역이 없다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings/7?tab=overview");

  await expect(page.getByRole("heading", { name: "회의 정보" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "내 정리" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "카테고리" })).toHaveCount(0);
  await expect(page.getByLabel("내 표시 이름")).toHaveCount(0);
});

test("업로드 대화상자의 회의 일시 기본값은 오늘이다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings");

  await page.getByRole("button", { name: "회의 업로드" }).click();
  const dialog = page.getByRole("dialog");
  const today = await page.evaluate(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  );
  await expect(dialog.getByLabel("회의 일시")).toHaveValue(new RegExp(`^${today}T`));
});

test("새로고침해도 딥링크가 그대로 열린다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings/7?tab=transcript");
  await expect(page.getByText(/승인된 회의록은 수정할 수 없습니다/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/승인된 회의록은 수정할 수 없습니다/)).toBeVisible();
});

test.describe("좁은 화면", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("1024에서도 사이드바·입력창·대화상자가 화면 안에 있다", async ({ page }) => {
    await stubApi(page, { signedIn: true, scope: [], withMessages: true });
    await page.goto("/chat/3");

    await expect(page.getByRole("complementary", { name: "사이드바" }).getByRole("button", { name: "새 채팅" })).toBeVisible();

    const composer = (await page.getByLabel("질문", { exact: true }).boundingBox())!;
    expect(composer.x).toBeGreaterThan(240); // clear of the 15rem sidebar
    expect(composer.x + composer.width).toBeLessThanOrEqual(1024);

    await page.getByRole("button", { name: "범위 변경" }).click();
    const dialog = page.getByRole("dialog");
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y).toBeGreaterThanOrEqual(0);

    // The meeting filter toolbar and the category rows wrap instead of
    // overflowing. Neither page may scroll sideways.
    await page.keyboard.press("Escape");
    const overflow = async () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

    await page.goto("/meetings");
    expect(await overflow()).toBeLessThanOrEqual(1);

    await page.goto("/chat/3");
    await expect(page.getByRole("heading", { name: "비밀번호 전달 방법" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
  });
});
