import { expect, test, type Page } from "@playwright/test";

const ME = { id: 1, username: "tester", display_name: "테스터" };

const MEETING = {
  id: 7, title: "8월 3주차 개발 회의", original_filename: "weekly.m4a",
  stored_filename: "abc.m4a", duration: 1830, language: "ko", status: "COMPLETED",
  error_message: null, created_at: "2026-08-20T01:00:00+00:00",
  held_at: "2026-08-19T01:00:00+00:00", intelligence_state: "READY",
  intelligence_error: null, speaker_count: 2,
};
const OTHER = { ...MEETING, id: 8, title: "기획 리뷰" };

const SESSION = {
  id: 3, title: "비밀번호 전달 방법", scope_meeting_ids: [] as number[],
  updated_at: "2026-08-21T00:00:00Z",
};

/** One API stub for the whole app, installed in the browser. */
async function stubApi(page: Page, state: { signedIn: boolean; scope: number[] }) {
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
    if (path === "/api/meetings") return route.fulfill(json([MEETING, OTHER]));
    if (path === "/api/meetings/7") {
      return route.fulfill(json({
        meeting: MEETING,
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
    if (path === "/api/chat/sessions" && method === "GET") {
      return route.fulfill(json([{ ...SESSION, scope_meeting_ids: state.scope }]));
    }
    if (path === "/api/chat/sessions/3" && method === "GET") {
      return route.fulfill(json({
        session: { ...SESSION, scope_meeting_ids: state.scope },
        messages: [],
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

  await page.getByRole("link", { name: "회의", exact: true }).first().click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "회의", exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByText("기획 리뷰")).toBeVisible();

  await page.getByRole("link", { name: "채팅", exact: true }).first().click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByText("전체 회의")).toBeVisible();
});

test("검색 범위 대화상자는 ESC로 닫히고, 여러 회의를 고를 수 있다", async ({ page }) => {
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
  await dialog.getByRole("checkbox").nth(0).check();
  await dialog.getByRole("checkbox").nth(1).check();
  await expect(dialog.getByText("2개 선택됨")).toBeVisible();
  await dialog.getByRole("button", { name: "선택 완료" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("선택한 회의 2개")).toBeVisible();
  expect(state.scope).toEqual([7, 8]);
});

test("새로고침해도 딥링크가 그대로 열린다", async ({ page }) => {
  await stubApi(page, { signedIn: true, scope: [] });
  await page.goto("/meetings/7?tab=transcript");
  await expect(page.getByText(/승인된 회의록은 읽기 전용입니다/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/승인된 회의록은 읽기 전용입니다/)).toBeVisible();
});
