import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_OK, CATEGORIES, meeting, mockApi, mockUpload, renderAt } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
const LONG_AGO = new Date(Date.now() - 400 * 86_400_000).toISOString();

const ROWS = [
  meeting({ held_at: RECENT }),
  meeting({ id: 8, title: "기획 리뷰", status: "REVIEW_REQUIRED", held_at: RECENT }),
  meeting({ id: 10, title: "작년 회의", held_at: LONG_AGO, created_at: LONG_AGO }),
];

describe("회의 목록", () => {
  it("불러오는 동안 자리표시자를 보여준다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: [] }, CATEGORIES]);
    renderAt("/");
    expect(await screen.findByLabelText("불러오는 중")).toBeInTheDocument();
  });

  it("회의가 하나도 없으면 무엇을 하면 되는지 알려준다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: [] }, CATEGORIES]);
    renderAt("/");
    expect(await screen.findByText("아직 등록된 회의가 없습니다.")).toBeInTheDocument();
    // Nothing to clear: this is not the filtered-empty state.
    expect(screen.queryByRole("button", { name: "필터 초기화" })).not.toBeInTheDocument();
  });

  it("회의를 표로 보여주고 상태를 한국어로 쓴다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    expect(await screen.findByText("8월 3주차 개발 회의")).toBeInTheDocument();
    // Scoped to the table: the same words are also the status filter's options.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("검토 필요")).toBeInTheDocument();
    expect(table.getAllByText("완료").length).toBeGreaterThan(0);
  });

  it("held_at이 없으면 등록일이라고 밝히고 회의 일시인 척하지 않는다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: [meeting({ held_at: null })] }, CATEGORIES]);
    renderAt("/");
    const row = (await screen.findByText("8월 3주차 개발 회의")).closest("tr")!;
    expect(within(row).getByText(/등록$/)).toBeInTheDocument();
  });

  it("검색어로 목록을 좁힌다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "기획");
    expect(screen.getByText("기획 리뷰")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });

  it("상태로 목록을 좁힌다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    await userEvent.selectOptions(
      await screen.findByLabelText("상태로 거르기"), "REVIEW_REQUIRED",
    );
    expect(screen.getByText("기획 리뷰")).toBeInTheDocument();
    expect(screen.queryByText("8월 3주차 개발 회의")).not.toBeInTheDocument();
  });

  it("기간으로 목록을 좁힌다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    expect(await screen.findByText("작년 회의")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("기간으로 거르기"), "30");
    expect(screen.queryByText("작년 회의")).not.toBeInTheDocument();
  });

  it("걸린 필터는 칩으로 보이고 하나씩 또는 한 번에 풀 수 있다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "기획");
    await userEvent.selectOptions(screen.getByLabelText("상태로 거르기"), "REVIEW_REQUIRED");

    await userEvent.click(screen.getByRole("button", { name: '"기획" 필터 해제' }));
    expect(screen.getByLabelText("회의 검색")).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(screen.getByText("8월 3주차 개발 회의")).toBeInTheDocument();
    expect(screen.getByText("작년 회의")).toBeInTheDocument();
  });

  it("조건 때문에 0건인 것과 아예 0건인 것을 구분한다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    await userEvent.type(await screen.findByLabelText("회의 검색"), "없는회의");
    expect(screen.getByText("조건에 맞는 회의가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("아직 등록된 회의가 없습니다.")).not.toBeInTheDocument();
  });

  it("정렬 기준을 바꿀 수 있다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
    renderAt("/");
    await screen.findByRole("table");
    const order = () =>
      screen.getAllByLabelText(/상세 보기$/).map((r) => r.getAttribute("aria-label"));

    expect(order().at(-1)).toContain("작년 회의");
    await userEvent.selectOptions(screen.getByLabelText("정렬"), "held_asc");
    expect(order().at(0)).toContain("작년 회의");
  });
});

describe("회의 업로드", () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "회의 업로드" }));
    return screen.findByRole("dialog");
  };

  it("회의 일시 기본값은 오늘이고 바꿀 수 있다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
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
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
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
    mockApi([AUTH_OK, { path: "/api/meetings", body: ROWS }, CATEGORIES]);
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
