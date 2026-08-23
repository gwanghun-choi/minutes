import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_OK, ME, meetingDetail, mockApi, renderAt, SEGMENTS, sharesRoute,
  versionsRoute, type Route,
} from "./harness";

afterEach(() => vi.unstubAllGlobals());

const INTEL: Route = {
  path: "/api/meetings/7/intelligence",
  body: { state: "READY", error: null, facts: [] },
};
const NO_SUMMARY: Route = {
  path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" },
};

/** v1 published, nothing open. */
const settled: Route = { path: "/api/meetings/7", body: meetingDetail() };

/** v2 open and on screen — the state an owner is in while correcting minutes. */
const drafting: Route = {
  path: "/api/meetings/7",
  body: meetingDetail({ version: 2, active_version: 1, draft_version: 2 }),
};

const HISTORY = versionsRoute(7, {
  active_version: 1,
  versions: [
    {
      version: 2, status: "DRAFT", created_at: "2026-08-22T01:00:00+00:00",
      published_at: null, created_by: ME.display_name, segment_count: 2,
    },
    {
      version: 1, status: "PUBLISHED", created_at: "2026-08-20T01:00:00+00:00",
      published_at: "2026-08-20T02:00:00+00:00", created_by: ME.display_name,
      segment_count: 2,
    },
  ],
});

describe("버전 패널", () => {
  it("현재 검색에 쓰이는 버전을 먼저 말한다", async () => {
    mockApi([AUTH_OK, settled, INTEL, NO_SUMMARY, versionsRoute(), sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText(/현재 검색·열람에 쓰이는 버전은/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /회의록 수정/ })).toBeInTheDocument();
  });

  it("수정 중에도 검색은 현재 버전을 쓴다는 것을 화면에서 말한다", async () => {
    mockApi([AUTH_OK, drafting, INTEL, NO_SUMMARY, HISTORY, sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    expect(
      await screen.findByText(/수정하는 동안에도 채팅과 검색은 계속 v1 를 사용하고/),
    ).toBeInTheDocument();
    // The history is its own request, so it arrives after the paragraph above.
    expect(await screen.findByText("수정 중")).toBeInTheDocument();
    expect(screen.getByText("현재 버전")).toBeInTheDocument();
  });

  it("수정본이 열려 있으면 새로 만드는 대신 이어서 수정하게 한다", async () => {
    mockApi([AUTH_OK, drafting, INTEL, NO_SUMMARY, HISTORY, sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByRole("button", { name: "v2 이어서 수정" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /회의록 수정$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /수정 취소/ })).toBeInTheDocument();
  });

  it("[회의록 수정]은 새 버전을 만들고 그 버전을 연다", async () => {
    const calls = mockApi([
      AUTH_OK, settled, INTEL, NO_SUMMARY, versionsRoute(), sharesRoute(),
      {
        method: "POST", path: "/api/meetings/7/versions",
        body: { meeting_id: 7, version: 2, status: "DRAFT" },
      },
      // the page re-reads the meeting at the version it navigated to
      { path: "/api/meetings/7?version=2", body: meetingDetail({ version: 2, draft_version: 2 }) },
    ]);
    renderAt("/meetings/7?tab=overview");

    await userEvent.click(await screen.findByRole("button", { name: /회의록 수정/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/versions"))).toBe(true),
    );
    await waitFor(() => expect(calls.some((c) => c.url.includes("version=2"))).toBe(true));
  });

  it("수정 취소는 현재 버전과 검색이 그대로라는 것을 확인시킨다", async () => {
    mockApi([AUTH_OK, drafting, INTEL, NO_SUMMARY, HISTORY, sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    await userEvent.click(await screen.findByRole("button", { name: /수정 취소/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/현재 버전 v1 와 검색 결과는 그대로/)).toBeInTheDocument();
  });
});

describe("수정 중인 회의록", () => {
  const editable = {
    path: "/api/meetings/7?version=2",
    body: meetingDetail({
      version: 2, active_version: 1, draft_version: 2,
      segments: SEGMENTS.map((s) => ({ ...s })),
    }),
  };

  it("승인 전까지 어느 버전이 검색되는지 회의록 위에서 말한다", async () => {
    mockApi([AUTH_OK, editable, INTEL, NO_SUMMARY, HISTORY, sharesRoute()]);
    renderAt("/meetings/7?tab=transcript&version=2");

    expect(await screen.findByText("v2 수정 중입니다.")).toBeInTheDocument();
    expect(screen.getByText(/계속 현재 버전 v1을 사용합니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("발화 0 내용")).toBeInTheDocument();
  });

  it("승인 확인창은 실패하면 기존 버전이 유지된다는 것까지 말한다", async () => {
    mockApi([AUTH_OK, editable, INTEL, NO_SUMMARY, HISTORY, sharesRoute()]);
    renderAt("/meetings/7?tab=transcript&version=2");

    await userEvent.click(await screen.findByRole("button", { name: /승인하고 인덱싱/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/인덱싱이 실패하면 계속 v1이 검색에 사용됩니다/))
      .toBeInTheDocument();
  });

  it("현재 버전을 열면 읽기 전용이고, 고치려면 새 버전이 필요하다고 말한다", async () => {
    mockApi([
      AUTH_OK,
      { path: "/api/meetings/7?version=1", body: meetingDetail({ version: 1, draft_version: 2 }) },
      INTEL, NO_SUMMARY, HISTORY, sharesRoute(),
    ]);
    renderAt("/meetings/7?tab=transcript&version=1");

    expect(await screen.findByText(/현재 버전은 읽기 전용입니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
  });

  it("이전 버전은 기록으로만 읽힌다", async () => {
    mockApi([
      AUTH_OK,
      {
        path: "/api/meetings/7?version=1",
        body: meetingDetail({ version: 1, active_version: 2, draft_version: null }),
      },
      INTEL, NO_SUMMARY, HISTORY, sharesRoute(),
    ]);
    renderAt("/meetings/7?tab=transcript&version=1");

    expect(await screen.findByText(/v1은 이전 버전입니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
  });
});

describe("공유받은 사람이 보는 버전", () => {
  it("기록은 볼 수 있고 수정 버튼은 없다", async () => {
    mockApi([
      AUTH_OK,
      {
        path: "/api/meetings/7",
        body: meetingDetail({
          role: "SHARED_READ", shared_with: null, draft_version: null,
          owner_user_id: 99, owner_display_name: "최광훈",
        }),
      },
      INTEL, NO_SUMMARY, versionsRoute(),
    ]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText("현재 버전")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /회의록 수정/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수정 취소/ })).not.toBeInTheDocument();
  });

  it("새 버전이 현재 버전이 되면 다시 초대받지 않고도 그것을 본다", async () => {
    mockApi([
      AUTH_OK,
      {
        path: "/api/meetings/7",
        body: meetingDetail({
          role: "SHARED_READ", shared_with: null, draft_version: null,
          version: 2, active_version: 2,
          owner_user_id: 99, owner_display_name: "최광훈",
        }),
      },
      INTEL, NO_SUMMARY,
      versionsRoute(7, {
        active_version: 2,
        versions: [
          {
            version: 2, status: "PUBLISHED", created_at: "2026-08-22T01:00:00+00:00",
            published_at: "2026-08-22T03:00:00+00:00", created_by: "최광훈", segment_count: 2,
          },
          {
            version: 1, status: "SUPERSEDED", created_at: "2026-08-20T01:00:00+00:00",
            published_at: "2026-08-20T02:00:00+00:00", created_by: "최광훈", segment_count: 2,
          },
        ],
      }),
    ]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText(/현재 검색·열람에 쓰이는 버전은/)).toBeInTheDocument();
    expect(await screen.findByText("현재 버전")).toBeInTheDocument();
    expect(screen.getByText("이전 버전")).toBeInTheDocument();
    // …and the page header says which one, so an updated meeting reads as updated
    expect(screen.getAllByText("v2").length).toBeGreaterThan(0);
  });
});
