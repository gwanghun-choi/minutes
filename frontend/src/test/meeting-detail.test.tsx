import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_OK, CATEGORIES, FACTS, meetingDetail, meetingsRoute, mockApi, renderAt,
  sharesRoute, versionsRoute, type Route,
} from "./harness";

afterEach(() => vi.unstubAllGlobals());

const detail = (over: Record<string, unknown> = {}): Route => ({
  path: "/api/meetings/7",
  body: meetingDetail(over),
});

/* The overview draws a version panel and, for an owner, a sharing panel. Both
   are their own requests, so every test that opens the overview needs them. */
const VERSIONS = versionsRoute();
const SHARES = sharesRoute();

const INTEL: Route = {
  path: "/api/meetings/7/intelligence",
  body: { state: "READY", error: null, facts: FACTS },
};
const SUMMARY: Route = {
  path: "/api/meetings/7/summary",
  body: { meeting_id: 7, content: "핵심 요약\n- 비밀번호는 문자로 전달" },
};

describe("회의 상세", () => {
  it("회의 정보와 상태를 머리말에 보여준다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7");
    expect(await screen.findByRole("heading", { name: /8월 3주차 개발 회의/ })).toBeInTheDocument();
    expect(screen.getByText("완료")).toBeInTheDocument();
    expect(screen.getByText("30:30")).toBeInTheDocument();
  });

  it("회의 일시를 네이티브 입력으로 고칠 수 있다", async () => {
    const calls = mockApi([
      AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES,
      { method: "PUT", path: "/api/meetings/7/held-at", body: { id: 7, held_at: null } },
    ]);
    renderAt("/meetings/7?tab=overview");

    const field = await screen.findByLabelText("회의 일시");
    expect(field).toHaveAttribute("type", "datetime-local");
    await userEvent.clear(field);
    await userEvent.type(field, "2026-08-18T14:30");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/held-at"))).toBe(true),
    );
  });

  it("held_at이 없으면 미설정이라고 밝힌다", async () => {
    mockApi([AUTH_OK, detail({ held_at: null }), INTEL, SUMMARY]);
    renderAt("/meetings/7?tab=overview");
    expect(await screen.findByText(/미설정/)).toBeInTheDocument();
  });

  it("요약을 보여주고 다시 생성할 수 있다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=overview");
    expect(await screen.findByText(/비밀번호는 문자로 전달/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 생성" })).toBeInTheDocument();
  });

  it("요약이 아직 없으면 실패가 아니라 상태로 보여준다", async () => {
    mockApi([
      AUTH_OK, detail(), INTEL,
      { path: "/api/meetings/7/summary", status: 404, body: { detail: "아직 생성된 요약이 없습니다." } },
    ]);
    renderAt("/meetings/7?tab=overview");
    expect(await screen.findByText("아직 생성된 요약이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "요약 생성" })).toBeInTheDocument();
  });

  it("화자마다 색과 이름이 함께 나오고 내가 누구인지 표시된다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7");
    const mine = await screen.findByRole("button", { name: "나" });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "나로 지정" })).toHaveAttribute(
      "aria-pressed", "false",
    );
  });

  it("나로 지정을 다시 누르면 지정이 해제된다", async () => {
    const calls = mockApi([
      AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES,
      { method: "PUT", path: "/api/meetings/7/me", body: { speaker_id: null } },
    ]);
    renderAt("/meetings/7");
    await userEvent.click(await screen.findByRole("button", { name: "나" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ speaker_id: null }),
    );
  });
});

describe("회의 인사이트", () => {
  it("요청·결정·할 일을 근거와 함께 보여준다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=intelligence");

    expect(await screen.findByText("현관 비밀번호를 남겨 달라는 요청")).toBeInTheDocument();
    expect(screen.getByText("통화 종료 후 현관 비밀번호를 문자로 전달")).toBeInTheDocument();
    expect(screen.getByText("전달 수단은 문자로 한다")).toBeInTheDocument();
    // Scoped to the fact list: the speaker bar above it names them too.
    const facts = within(screen.getByRole("list", { name: "추출된 정보" }));
    expect(facts.getByText("화자 B")).toBeInTheDocument();
    expect(facts.getAllByText("화자 A").length).toBeGreaterThan(0);
  });

  it("근거 원문은 접혀 있고 펼치면 그 발화가 보인다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=intelligence");

    const toggle = (await screen.findAllByRole("button", { name: /원문 \d+개 발화/ }))[1]!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(await screen.findByText(/문자로 남겨드리겠습니다/)).toBeInTheDocument();
  });

  it("상태 미확인을 진행 중이라고 바꿔 말하지 않는다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=intelligence");
    expect((await screen.findAllByText("상태 미확인")).length).toBeGreaterThan(0);
    expect(screen.queryByText("진행 중")).not.toBeInTheDocument();
    expect(
      screen.getByText(/회의에서 완료 여부가 언급되지 않았다는 뜻입니다/),
    ).toBeInTheDocument();
  });

  it("종류로 목록을 거를 수 있다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=intelligence");
    await userEvent.click(await screen.findByRole("button", { name: "요청 1" }));
    expect(screen.getByText("현관 비밀번호를 남겨 달라는 요청")).toBeInTheDocument();
    expect(screen.queryByText("전달 수단은 문자로 한다")).not.toBeInTheDocument();
  });

  it("승인 전에는 왜 비어 있는지와 다음에 할 일을 함께 말한다", async () => {
    mockApi([AUTH_OK, detail({ status: "REVIEW_REQUIRED", intelligence_state: "NOT_BUILT" })]);
    renderAt("/meetings/7?tab=intelligence");

    // Not a skeleton and not a bare sentence: the state, the reason, the steps.
    expect(await screen.findByText("아직 추출된 인사이트가 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("현재 상태")).toBeInTheDocument();
    expect(screen.getByText(/승인해야 검색과 생성의 근거가 됩니다/)).toBeInTheDocument();
    expect(screen.getByText("승인하고 인덱싱")).toBeInTheDocument();
  });
});

describe("승인 전 개요", () => {
  it("빈 카드가 아니라 상태·이유·다음 행동을 보여준다", async () => {
    mockApi([AUTH_OK, detail({ status: "REVIEW_REQUIRED", intelligence_state: "NOT_BUILT" })]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText("아직 생성된 요약이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("회의록 탭에서 초안 검토")).toBeInTheDocument();
    // No fake summary and no skeleton pretending something is loading.
    expect(screen.queryByLabelText("불러오는 중")).not.toBeInTheDocument();
  });

  it("검토하기를 누르면 회의록 탭으로 넘어간다", async () => {
    mockApi([AUTH_OK, detail({ status: "REVIEW_REQUIRED", intelligence_state: "NOT_BUILT" })]);
    renderAt("/meetings/7?tab=overview");
    await userEvent.click(await screen.findByRole("button", { name: "회의록 검토하기" }));
    expect(await screen.findByLabelText("발화 0 내용")).toBeInTheDocument();
  });

  it("분석 중이면 승인이 아니라 진행 중이라고 말한다", async () => {
    mockApi([AUTH_OK, detail({ status: "TRANSCRIBING", intelligence_state: "NOT_BUILT" })]);
    renderAt("/meetings/7?tab=overview");
    expect(await screen.findByText(/음성을 텍스트로 바꾸고 있습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "회의록 검토하기" })).not.toBeInTheDocument();
  });
});

describe("회의록 검토 (HITL)", () => {
  const review = detail({ status: "REVIEW_REQUIRED", intelligence_state: "NOT_BUILT" });

  it("검토 단계에서는 회의록을 고칠 수 있다", async () => {
    mockApi([AUTH_OK, review]);
    renderAt("/meetings/7");
    expect(await screen.findByLabelText("발화 0 내용")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "수정 내용 저장" })).toBeInTheDocument();
  });

  it("승인된 회의록은 읽기 전용이고 그 이유를 알려준다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=transcript");
    // Approved minutes are immutable, and the notice says why rather than
    // offering a way round it: there is none.
    expect(await screen.findByText(/승인된 회의록은 수정할 수 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/공유받은 사람의 답변이 모두 이 문장을 그대로 인용/))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
  });

  it("고친 내용을 저장하면 그 문장이 서버로 간다", async () => {
    const calls = mockApi([
      AUTH_OK, review,
      { method: "PATCH", path: "/api/meetings/7/transcript", body: { updated: 2 } },
    ]);
    renderAt("/meetings/7");

    const box = await screen.findByLabelText("발화 1 내용");
    await userEvent.clear(box);
    await userEvent.type(box, "문자로 남겨드리겠습니다.");
    await userEvent.click(screen.getByRole("button", { name: "수정 내용 저장" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      const segments = (patch!.body as { segments: { sequence: number; text: string }[] }).segments;
      expect(segments.find((s) => s.sequence === 1)?.text).toBe("문자로 남겨드리겠습니다.");
    });
  });

  it("승인은 확인을 거치고, 승인 전에 반드시 저장한다", async () => {
    const calls = mockApi([
      AUTH_OK, review,
      { method: "PATCH", path: "/api/meetings/7/transcript", body: { updated: 2 } },
      { method: "POST", path: "/api/meetings/7/approve", body: { id: 7, status: "INDEXING" } },
    ]);
    renderAt("/meetings/7");

    await userEvent.click(await screen.findByRole("button", { name: "승인하고 인덱싱" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/이후에는 수정할 수 없습니다/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "저장하고 승인" }));

    await waitFor(() => {
      const order = calls.filter((c) => c.method === "PATCH" || c.method === "POST").map((c) => c.url);
      expect(order.indexOf("/api/meetings/7/transcript")).toBeLessThan(
        order.indexOf("/api/meetings/7/approve"),
      );
    });
  });

  it("AI 후보정은 제안일 뿐이고 반영해도 저장되지 않는다", async () => {
    const calls = mockApi([
      AUTH_OK, review,
      {
        method: "POST", path: "/api/meetings/7/corrections",
        body: { suggestions: [{ sequence: 1, before: "문자로", after: "문자 메시지로" }] },
      },
    ]);
    renderAt("/meetings/7");

    await userEvent.click(await screen.findByRole("button", { name: "AI 후보정" }));
    expect(await screen.findByText("문자 메시지로")).toBeInTheDocument();
    expect(screen.getByText(/눌러야 기록됩니다/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "반영" }));
    expect(await screen.findByLabelText("발화 1 내용")).toHaveValue("문자 메시지로");
    // Applying writes nothing: only the reviewer's save does.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("위험한 작업", () => {
  it("삭제는 확인을 거치고 무엇이 사라지는지 말한다", async () => {
    const calls = mockApi([
      AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES,
      { method: "DELETE", path: "/api/meetings/7", body: { id: 7, deleted: true } },
    ]);
    renderAt("/meetings/7?tab=overview");

    await userEvent.click(await screen.findByRole("button", { name: "회의 삭제" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/되돌릴 수 없습니다/)).toBeInTheDocument();
    // Nothing has gone to the server yet.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("재임베딩은 사용자 언어로 부르고 무엇을 다시 하지 않는지 밝힌다", async () => {
    mockApi([AUTH_OK, detail(), INTEL, SUMMARY, VERSIONS, SHARES]);
    renderAt("/meetings/7?tab=overview");
    await userEvent.click(await screen.findByRole("button", { name: "검색 인덱스 다시 생성" }));
    expect(
      within(await screen.findByRole("dialog")).getByText(/음성 인식과 화자 분리는 다시 실행하지 않습니다/),
    ).toBeInTheDocument();
  });

  /**
   * The UAT case: the server died mid-analysis, so the meeting sits in
   * 화자 분리 중 with no task behind it. Deleting it has to be possible from
   * here, because nothing else will ever move it.
   */
  it.each(["DIARIZING", "TRANSCRIBING", "UPLOADED", "REVIEW_REQUIRED", "FAILED", "INDEXING"])(
    "%s 상태에서도 삭제할 수 있다",
    async (status) => {
      const calls = mockApi([
        AUTH_OK, detail({ status }), INTEL,
        { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
        { method: "DELETE", path: "/api/meetings/7", body: { id: 7, deleted: true } },
      ]);
      renderAt("/meetings/7?tab=overview");

      await userEvent.click(await screen.findByRole("button", { name: "회의 삭제" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    },
  );

  it("분석이 끝나지 않은 회의는 삭제 전에 그 사실을 알린다", async () => {
    mockApi([
      AUTH_OK, detail({ status: "DIARIZING" }), INTEL,
      { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
    ]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText(/서버가 재시작된 뒤라면/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "회의 삭제" }));
    expect(
      within(await screen.findByRole("dialog")).getByText(/아무것도 저장하지 못한 채 끝납니다/),
    ).toBeInTheDocument();
    // Nothing to re-embed before there is an approved transcript.
    expect(
      screen.queryByRole("button", { name: "검색 인덱스 다시 생성" }),
    ).not.toBeInTheDocument();
  });

  it("삭제가 성공하면 회의 목록으로 돌아간다", async () => {
    mockApi([
      AUTH_OK, detail({ status: "DIARIZING" }), INTEL,
      { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
      { method: "DELETE", path: "/api/meetings/7", body: { id: 7, deleted: true } },
      meetingsRoute([]),
      CATEGORIES,
    ]);
    renderAt("/meetings/7?tab=overview");

    await userEvent.click(await screen.findByRole("button", { name: "회의 삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );

    expect(await screen.findByRole("heading", { name: "회의" })).toBeInTheDocument();
  });

  it("삭제가 실패하면 서버가 준 이유를 보여주고 화면에 머문다", async () => {
    mockApi([
      AUTH_OK, detail({ status: "DIARIZING" }), INTEL,
      { path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" } },
      {
        method: "DELETE", path: "/api/meetings/7", status: 500,
        body: { detail: "삭제할 수 없습니다." },
      },
    ]);
    renderAt("/meetings/7?tab=overview");

    await userEvent.click(await screen.findByRole("button", { name: "회의 삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );

    expect(await screen.findByText("삭제할 수 없습니다.")).toBeInTheDocument();
    // The dialog stays open, so the user is still on the meeting and can retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
