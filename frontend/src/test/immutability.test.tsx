import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_OK, ME, meetingDetail, mockApi, renderAt, SEGMENTS, sharesRoute, type Route,
} from "./harness";

afterEach(() => vi.unstubAllGlobals());

/**
 * Approved minutes are immutable, on screen as well as on the server.
 *
 * The screen's job here is narrow: never offer an action the server would
 * refuse, and say plainly why the transcript is read-only. The refusal itself is
 * `tests/test_versions.py` — hiding a button is presentation, not a boundary.
 */
const INTEL: Route = {
  path: "/api/meetings/7/intelligence",
  body: { state: "READY", error: null, facts: [] },
};
const NO_SUMMARY: Route = {
  path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" },
};

const approved: Route = { path: "/api/meetings/7", body: meetingDetail() };
const reviewing: Route = {
  path: "/api/meetings/7",
  body: meetingDetail({ status: "REVIEW_REQUIRED", segments: SEGMENTS.map((s) => ({ ...s })) }),
};

describe("승인 전 — 회의록을 고칠 수 있는 유일한 단계", () => {
  it("초안은 편집할 수 있고, 승인하면 끝이라고 말한다", async () => {
    mockApi([AUTH_OK, reviewing, INTEL, NO_SUMMARY, sharesRoute()]);
    renderAt("/meetings/7?tab=transcript");

    expect(await screen.findByText("검토가 필요합니다.")).toBeInTheDocument();
    expect(screen.getByText(/승인하면 검색 대상이 되면서 더 이상 수정할 수 없습니다/))
      .toBeInTheDocument();
    expect(screen.getByLabelText("발화 0 내용")).toBeInTheDocument();
  });

  it("승인 확인창이 되돌릴 수 없다는 것을 먼저 말한다", async () => {
    mockApi([AUTH_OK, reviewing, INTEL, NO_SUMMARY, sharesRoute()]);
    renderAt("/meetings/7?tab=transcript");

    await userEvent.click(await screen.findByRole("button", { name: /승인하고 인덱싱/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/이후에는 수정할 수 없습니다/)).toBeInTheDocument();
  });
});

describe("승인 후 — 회의록은 읽기 전용", () => {
  it("회의록 탭이 읽기 전용이고 그 이유를 말한다", async () => {
    mockApi([AUTH_OK, approved, INTEL, NO_SUMMARY, sharesRoute()]);
    renderAt("/meetings/7?tab=transcript");

    expect(await screen.findByText(/승인된 회의록은 수정할 수 없습니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수정 내용 저장/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /승인하고 인덱싱/ })).not.toBeInTheDocument();
  });

  it("새 버전을 만들거나 취소하는 조작이 화면에 없다", async () => {
    mockApi([AUTH_OK, approved, INTEL, NO_SUMMARY, sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByRole("heading", { name: "회의 정보" })).toBeInTheDocument();
    for (const name of [/회의록 수정/, /이어서 수정/, /수정 취소/, /수정본/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "버전" })).not.toBeInTheDocument();
  });

  it("화자 이름도 승인 후에는 바꿀 수 없다", async () => {
    mockApi([AUTH_OK, approved, INTEL, NO_SUMMARY, sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    await screen.findByRole("heading", { name: "회의 정보" });
    expect(screen.getByText(/\[나로 지정\]을 해 두면/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /이름 변경/ })).not.toBeInTheDocument();
  });
});

describe("공유받은 사람이 보는 회의록", () => {
  const shared: Route = {
    path: "/api/meetings/7",
    body: meetingDetail({
      role: "SHARED_READ", shared_with: null,
      owner_user_id: 99, owner_display_name: "최광훈", is_owner: false,
    }),
  };

  it("읽기 전용이고, 소유자만 고칠 수 있다고 말한다", async () => {
    mockApi([AUTH_OK, shared, INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=transcript");

    expect(await screen.findByText(/회의록은 소유자만 수정할 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
  });

  it("소유자 전용 조작이 하나도 그려지지 않는다", async () => {
    mockApi([AUTH_OK, shared, INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText("공유")).toBeInTheDocument();
    expect(screen.getByText("최광훈 공유")).toBeInTheDocument();
    for (const name of [/회의 삭제/, /검색 인덱스/, /사용자 초대/, /요약 생성/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("개인 정리는 이 화면이 아니라 행 메뉴에서 한다", async () => {
    /*
      A shared reader may still rename the meeting for themselves and file it in
      their own folder — migration 011 has not moved. What moved is where: the
      `⋯` on the row, in the sidebar tree and in the meeting list. The detail
      page is the meeting, not my arrangement of it, and a read-only card
      restating the arrangement would be the same detour with the controls
      taken out. Covered where it now lives: `사이드바 회의 행 메뉴` in
      categories.test.tsx and `공유받은 행에도 개인 정리 메뉴는 있고` in
      sharing.test.tsx.
    */
    mockApi([AUTH_OK, shared, INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=overview");

    await screen.findByRole("heading", { name: "회의 정보" });
    expect(screen.queryByRole("heading", { name: "내 정리" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("내 표시 이름")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("카테고리")).not.toBeInTheDocument();
  });
});

describe("이전 빌드가 남긴 두 번째 버전", () => {
  /** A database that ran the build with 회의록 수정 in it. v2 is published. */
  const revised: Route = {
    path: "/api/meetings/7?version=1",
    body: meetingDetail({ version: 1, active_version: 2, draft_version: null }),
  };

  it("기록으로 읽히고, 여전히 수정할 수 없다", async () => {
    mockApi([AUTH_OK, revised, INTEL, NO_SUMMARY, sharesRoute()]);
    renderAt("/meetings/7?tab=transcript&version=1");

    expect(await screen.findByText(/v1은 이전 기록입니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /회의록 수정/ })).not.toBeInTheDocument();
  });

  it("현재 버전이 v1이 아니면 헤더가 그 번호를 말한다", async () => {
    mockApi([
      AUTH_OK,
      { path: "/api/meetings/7", body: meetingDetail({ version: 2, active_version: 2 }) },
      INTEL, NO_SUMMARY, sharesRoute(),
    ]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(ME.display_name).toBeTruthy();
  });
});
