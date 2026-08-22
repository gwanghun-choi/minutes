import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_OK, CATEGORIES, meeting, meetingPage, meetingsRoute, MEETINGS_PATH, mockApi,
  mockUpload, renderAt,
} from "./harness";

afterEach(() => vi.unstubAllGlobals());

const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
const LONG_AGO = new Date(Date.now() - 400 * 86_400_000).toISOString();

const ROWS = [
  meeting({ held_at: RECENT }),
  meeting({ id: 8, title: "기획 리뷰", status: "REVIEW_REQUIRED", held_at: RECENT }),
  meeting({ id: 10, title: "작년 회의", held_at: LONG_AGO, created_at: LONG_AGO }),
];

/** The last list request the page made, as parameters. */
const lastQuery = (calls: { method: string; url: string }[]) => {
  const listed = calls.filter((c) => c.method === "GET" && MEETINGS_PATH.test(c.url));
  return new URL(listed.at(-1)!.url, "http://localhost").searchParams;
};

describe("회의 목록", () => {
  it("불러오는 동안 자리표시자를 보여준다", async () => {
    // The list is held open, so the loading state is observable rather than a
    // race against the stub.
    mockApi([
      AUTH_OK, CATEGORIES,
      { path: MEETINGS_PATH, delay: 300, body: meetingPage([]) },
    ]);
    renderAt("/");
    expect((await screen.findAllByLabelText("불러오는 중")).length).toBeGreaterThan(0);
  });

  it("회의가 하나도 없으면 무엇을 하면 되는지 알려준다", async () => {
    mockApi([AUTH_OK, meetingsRoute([]), CATEGORIES]);
    renderAt("/");
    expect(await screen.findByText("아직 등록된 회의가 없습니다.")).toBeInTheDocument();
    // Nothing to clear: this is not the filtered-empty state.
    expect(screen.queryByRole("button", { name: "필터 초기화" })).not.toBeInTheDocument();
  });

  it("회의를 표로 보여주고 상태를 한국어로 쓴다", async () => {
    mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    expect(await screen.findByText("8월 3주차 개발 회의")).toBeInTheDocument();
    // Scoped to the table: the same words are also the status filter's options.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("검토 필요")).toBeInTheDocument();
    expect(table.getAllByText("완료").length).toBeGreaterThan(0);
  });

  it("held_at이 없으면 등록일이라고 밝히고 회의 일시인 척하지 않는다", async () => {
    mockApi([AUTH_OK, meetingsRoute([meeting({ held_at: null })]), CATEGORIES]);
    renderAt("/");
    const row = (await screen.findByText("8월 3주차 개발 회의")).closest("tr")!;
    expect(within(row).getByText(/등록$/)).toBeInTheDocument();
  });

  it("검색어는 서버 질의로 나가고 돌아온 페이지를 그린다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "기획");

    await waitFor(() => expect(lastQuery(calls).get("q")).toBe("기획"));
    expect(screen.getByText("기획 리뷰")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });

  it("상태로 목록을 좁힌다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    await userEvent.selectOptions(
      await screen.findByLabelText("상태로 거르기"), "REVIEW_REQUIRED",
    );
    await waitFor(() => expect(lastQuery(calls).get("status")).toBe("REVIEW_REQUIRED"));
    expect(screen.getByText("기획 리뷰")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });

  it("기간으로 목록을 좁힌다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    expect(await screen.findByText("작년 회의")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("기간으로 거르기"), "30");
    await waitFor(() => expect(lastQuery(calls).get("days")).toBe("30"));
    expect(screen.queryByText("작년 회의")).not.toBeInTheDocument();
  });

  it("걸린 필터는 칩으로 보이고 하나씩 또는 한 번에 풀 수 있다", async () => {
    mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "기획");
    await userEvent.selectOptions(screen.getByLabelText("상태로 거르기"), "REVIEW_REQUIRED");

    await userEvent.click(await screen.findByRole("button", { name: '"기획" 필터 해제' }));
    expect(screen.getByLabelText("회의 검색")).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(await screen.findByText("8월 3주차 개발 회의")).toBeInTheDocument();
    expect(screen.getByText("작년 회의")).toBeInTheDocument();
  });

  it("필터 상태는 URL에 남아 새로고침해도 유지된다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/?status=REVIEW_REQUIRED&q=기획");

    await waitFor(() => expect(lastQuery(calls).get("status")).toBe("REVIEW_REQUIRED"));
    expect(screen.getByLabelText("회의 검색")).toHaveValue("기획");
    expect(await screen.findByText("기획 리뷰")).toBeInTheDocument();
  });

  it("조건 때문에 0건인 것과 아예 0건인 것을 구분한다", async () => {
    mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "없는회의");
    expect(await screen.findByText("조건에 맞는 회의가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("아직 등록된 회의가 없습니다.")).not.toBeInTheDocument();
  });

  it("정렬 기준은 서버에 전달된다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");
    const order = () =>
      screen.getAllByLabelText(/상세 보기$/).map((r) => r.getAttribute("aria-label"));

    expect(order().at(-1)).toContain("작년 회의");
    await userEvent.selectOptions(screen.getByLabelText("정렬"), "held_asc");
    await waitFor(() => expect(lastQuery(calls).get("sort")).toBe("held_asc"));
    expect(order().at(0)).toContain("작년 회의");
  });
});

describe("회의 목록 페이지 이동", () => {
  const MANY = Array.from({ length: 25 }, (_, i) =>
    meeting({
      id: 100 + i,
      title: `회의 ${String(i).padStart(2, "0")}`,
      held_at: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
    }),
  );

  it("첫 페이지는 20개이고 전체 개수를 말한다", async () => {
    mockApi([AUTH_OK, meetingsRoute(MANY), CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");

    expect(screen.getAllByLabelText(/상세 보기$/)).toHaveLength(20);
    expect(screen.getByText("총 25개 중 1–20")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("다음 페이지로 넘어가면 나머지가 나온다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(MANY), CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(lastQuery(calls).get("page")).toBe("2"));
    expect(await screen.findByText("총 25개 중 21–25")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/상세 보기$/)).toHaveLength(5);
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeDisabled();
  });

  it("페이지당 개수를 바꿀 수 있다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(MANY), CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");

    await userEvent.selectOptions(screen.getByLabelText("페이지당 개수"), "50");
    await waitFor(() => expect(lastQuery(calls).get("page_size")).toBe("50"));
    expect(await screen.findByText("총 25개 중 1–25")).toBeInTheDocument();
  });

  it("필터를 바꾸면 1페이지로 돌아간다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(MANY), CATEGORIES]);
    renderAt("/?page=2");
    await waitFor(() => expect(lastQuery(calls).get("page")).toBe("2"));

    await userEvent.type(screen.getByLabelText("회의 검색"), "회의 0");
    await waitFor(() => {
      const q = lastQuery(calls);
      expect(q.get("q")).toBe("회의 0");
      expect(q.get("page")).toBe("1");       // back to the first page
    });
  });

  it("범위를 벗어난 페이지에서도 전체 개수는 정확하다", async () => {
    mockApi([
      AUTH_OK, CATEGORIES,
      { path: MEETINGS_PATH, body: meetingPage([], { total: 25, page: 9, page_size: 20 }) },
    ]);
    renderAt("/?page=9");
    expect(await screen.findByText("아직 등록된 회의가 없습니다.")).toBeInTheDocument();
  });
});

describe("회의 목록에서 삭제", () => {
  it("행 메뉴에서 삭제하고, 확인을 거친다", async () => {
    const calls = mockApi([
      AUTH_OK, meetingsRoute(ROWS), CATEGORIES,
      { method: "DELETE", path: "/api/meetings/8", body: { id: 8, deleted: true } },
    ]);
    renderAt("/");
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: "기획 리뷰 관리 메뉴" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/8"))).toBe(true),
    );
  });

  it("행 메뉴를 열어도 상세로 이동하지 않는다", async () => {
    const calls = mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: "기획 리뷰 관리 메뉴" }));
    expect(await screen.findByRole("menuitem", { name: "삭제" })).toBeInTheDocument();
    // The row is a link; opening its menu must not follow it. Nothing asked the
    // server for the meeting, which is what navigating would have done.
    expect(calls.some((c) => c.url.endsWith("/api/meetings/8"))).toBe(false);
  });
});

describe("회의 업로드", () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "회의 업로드" }));
    return screen.findByRole("dialog");
  };

  it("회의 일시 기본값은 오늘이고 바꿀 수 있다", async () => {
    mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    renderAt("/");
    const dialog = await open();

    const field = within(dialog).getByLabelText("회의 일시");
    expect(field).toHaveAttribute("type", "datetime-local");
    // Today, in the browser's own timezone — not the server's.
    expect(field).toHaveValue(
      new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) +
        (field as HTMLInputElement).value.slice(10),
    );

    await userEvent.clear(field);
    await userEvent.type(field, "2026-08-18T14:30");
    expect(field).toHaveValue("2026-08-18T14:30");
  });

  it("고른 회의 일시가 업로드 요청에 실려 간다", async () => {
    mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    const sent = mockUpload();
    renderAt("/");
    const dialog = await open();

    await userEvent.clear(within(dialog).getByLabelText("회의 일시"));
    await userEvent.type(within(dialog).getByLabelText("회의 일시"), "2026-08-18T14:30");
    await userEvent.upload(
      dialog.querySelector('input[type="file"]')!,
      new File([new Uint8Array([0])], "meeting.wav", { type: "audio/wav" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "업로드" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.get("held_at")).toBe(new Date("2026-08-18T14:30").toISOString());
  });

  it("회의 일시를 비우면 미설정으로 업로드된다", async () => {
    mockApi([AUTH_OK, meetingsRoute(ROWS), CATEGORIES]);
    const sent = mockUpload();
    renderAt("/");
    const dialog = await open();

    await userEvent.clear(within(dialog).getByLabelText("회의 일시"));
    await userEvent.upload(
      dialog.querySelector('input[type="file"]')!,
      new File([new Uint8Array([0])], "meeting.wav", { type: "audio/wav" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "업로드" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.get("held_at")).toBe("");
  });
});
