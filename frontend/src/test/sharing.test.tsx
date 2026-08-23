import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assistant, AUTH_OK, CATEGORIES, meeting, meetingDetail, meetingsRoute, mockApi,
  question, renderAt, sharesRoute, versionsRoute, type Route,
} from "./harness";

afterEach(() => vi.unstubAllGlobals());

const INTEL: Route = {
  path: "/api/meetings/7/intelligence",
  body: { state: "READY", error: null, facts: [] },
};
const NO_SUMMARY: Route = {
  path: "/api/meetings/7/summary", status: 404, body: { detail: "없음" },
};

const owned = (over: Record<string, unknown> = {}): Route => ({
  path: "/api/meetings/7",
  body: meetingDetail(over),
});

/** The same meeting as somebody else's, accepted. The server computes `role`. */
const shared = (over: Record<string, unknown> = {}): Route =>
  owned({
    role: "SHARED_READ",
    shared_with: null,
    draft_version: null,
    owner_user_id: 99,
    owner_display_name: "최광훈",
    ...over,
  });

const SHARE_ROW = {
  id: 5, invited_user_id: 42, status: "ACCEPTED",
  created_at: "2026-08-21T01:00:00+00:00",
  responded_at: "2026-08-21T02:00:00+00:00", revoked_at: null,
  username: "user2", display_name: "테스트 사용자 2",
};

describe("공유 관리 (소유자)", () => {
  it("공유 중인 사용자와 대기 중인 초대를 구분해서 보여준다", async () => {
    mockApi([
      AUTH_OK, owned(), INTEL, NO_SUMMARY, versionsRoute(),
      sharesRoute(7, [SHARE_ROW, { ...SHARE_ROW, id: 6, invited_user_id: 43, status: "PENDING", display_name: "박서연", username: "psy" }]),
    ]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText("테스트 사용자 2")).toBeInTheDocument();
    expect(screen.getByText("공유 중")).toBeInTheDocument();
    expect(screen.getByText("박서연")).toBeInTheDocument();
    expect(screen.getByText("승인 대기")).toBeInTheDocument();
    // The action is named for the state it undoes.
    expect(screen.getByRole("button", { name: "공유 해제" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "초대 취소" })).toBeInTheDocument();
  });

  it("사용자를 검색해서 초대하고, 보내는 것은 이름이 아니라 계정 id다", async () => {
    const calls = mockApi([
      AUTH_OK, owned(), INTEL, NO_SUMMARY, versionsRoute(), sharesRoute(),
      {
        path: /\/api\/users\?q=/,
        body: [{ id: 42, username: "user2", display_name: "테스트 사용자 2", share_status: null }],
      },
      { method: "POST", path: "/api/meetings/7/shares", body: { id: 9, status: "PENDING" } },
    ]);
    renderAt("/meetings/7?tab=overview");

    await userEvent.click(await screen.findByRole("button", { name: "사용자 초대" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("사용자 검색"), "user2");
    await userEvent.click(await within(dialog).findByRole("button", { name: "초대" }));

    await waitFor(() => {
      const sent = calls.find((c) => c.method === "POST" && c.url.endsWith("/shares"));
      expect(sent?.body).toEqual({ user_id: 42 });
    });
  });

  it("검색어를 입력하기 전에는 사용자 목록을 요청하지 않는다", async () => {
    const calls = mockApi([
      AUTH_OK, owned(), INTEL, NO_SUMMARY, versionsRoute(), sharesRoute(),
    ]);
    renderAt("/meetings/7?tab=overview");
    await userEvent.click(await screen.findByRole("button", { name: "사용자 초대" }));

    expect(await screen.findByText(/이름이나 아이디를 입력하세요/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/api/users"))).toBe(false);
  });

  it("이미 초대한 사용자에게는 초대 버튼 대신 상태를 보여준다", async () => {
    mockApi([
      AUTH_OK, owned(), INTEL, NO_SUMMARY, versionsRoute(), sharesRoute(),
      {
        path: /\/api\/users\?q=/,
        body: [{ id: 42, username: "user2", display_name: "테스트 사용자 2", share_status: "PENDING" }],
      },
    ]);
    renderAt("/meetings/7?tab=overview");
    await userEvent.click(await screen.findByRole("button", { name: "사용자 초대" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("사용자 검색"), "user2");

    expect(await within(dialog).findByText("승인 대기")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "초대" })).not.toBeInTheDocument();
  });

  it("공유 중인 회의를 삭제하기 전에 몇 명이 접근을 잃는지 말한다", async () => {
    mockApi([
      AUTH_OK, owned({ shared_with: 2 }), INTEL, NO_SUMMARY, versionsRoute(),
      sharesRoute(7, [SHARE_ROW]),
    ]);
    renderAt("/meetings/7?tab=overview");
    await userEvent.click(await screen.findByRole("button", { name: /회의 삭제/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/2명에게 공유 중입니다/)).toBeInTheDocument();
    expect(within(dialog).getByText(/더 이상 열람하거나 검색할 수 없습니다/)).toBeInTheDocument();
  });
});

describe("공유받은 회의 (읽는 쪽)", () => {
  it("공유자를 밝히고 관리 UI는 아예 그리지 않는다", async () => {
    mockApi([AUTH_OK, shared(), INTEL, NO_SUMMARY, versionsRoute()]);
    renderAt("/meetings/7?tab=overview");

    // 공유 is a badge on the title, never words inside it, and the owner is
    // named beside the status.
    expect(await screen.findByText("공유")).toBeInTheDocument();
    expect(screen.getByText("최광훈 공유")).toBeInTheDocument();
    // 요약 생성 and 인사이트 생성 are one policy: both belong to the owner, and
    // the server answers 403 to either — see tests/test_sharing.py.
    for (const name of [
      "회의 삭제", "검색 인덱스 다시 생성", "사용자 초대", "회의록 수정",
      "요약 생성", "인사이트 생성", "다시 생성",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    // …and the sharing panel itself is not on the page at all
    expect(screen.queryByText("공유 사용자")).not.toBeInTheDocument();
  });

  it("회의 정보는 읽기 전용으로 보여주고 소유자를 밝힌다", async () => {
    mockApi([AUTH_OK, shared(), INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText("공유자")).toBeInTheDocument();
    // canonical metadata is the owner's: the control is gone, not disabled
    expect(screen.queryByLabelText("회의 일시")).not.toBeInTheDocument();
    // …but arranging my own screen is mine, and those two controls are here
    expect(screen.getByLabelText("카테고리")).toBeInTheDocument();
    expect(screen.getByLabelText("내 표시 이름")).toBeInTheDocument();
  });

  it("회의록은 읽기 전용이고, 소유자만 고칠 수 있다고 말한다", async () => {
    mockApi([AUTH_OK, shared(), INTEL, NO_SUMMARY, versionsRoute()]);
    renderAt("/meetings/7?tab=transcript");

    expect(await screen.findByText(/소유자만 수정할 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("발화 0 내용")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /승인하고 인덱싱/ })).not.toBeInTheDocument();
  });

  it("[나로 지정]은 남아 있다 — 공유받은 것과 회의에 참석한 것은 다르다", async () => {
    mockApi([AUTH_OK, shared({ my_speaker_id: null }), INTEL, NO_SUMMARY, versionsRoute()]);
    renderAt("/meetings/7");

    expect((await screen.findAllByRole("button", { name: "나로 지정" })).length).toBeGreaterThan(0);
    expect(screen.getByText(/공유받은 회의라도 직접 지정해야 합니다/)).toBeInTheDocument();
  });
});

describe("회의 목록의 소유 구분", () => {
  const rows = [
    meeting({ id: 7, title: "내 회의", is_owner: true }),
    meeting({
      id: 8, title: "공유받은 회의", is_owner: false,
      owner_user_id: 99, owner_display_name: "최광훈",
    }),
  ];

  it("탭으로 내 회의와 공유받은 회의를 나눠 보고, 서버에 scope로 보낸다", async () => {
    const calls = mockApi([AUTH_OK, CATEGORIES, meetingsRoute(rows)]);
    renderAt("/");

    expect(await screen.findByText("내 회의")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "공유받은 회의" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("scope=shared"))).toBe(true),
    );
  });

  it("공유받은 행은 [공유] 배지와 공유자를 함께 밝힌다", async () => {
    mockApi([AUTH_OK, CATEGORIES, meetingsRoute(rows)]);
    renderAt("/");

    expect(await screen.findByText("공유")).toBeInTheDocument();
    expect(screen.getByText(/최광훈 공유/)).toBeInTheDocument();
    // …and only the shared row carries it
    expect(screen.getAllByText("공유")).toHaveLength(1);
  });

  it("공유받은 행에도 개인 정리 메뉴는 있고, 삭제만 없다", async () => {
    /*
      Filing is personal (migration 011): renaming a meeting on my own screen and
      moving it into my own folder change nothing anybody else sees, so a shared
      reader gets both. Deleting is the owner's, and the server refuses it from
      anybody else either way.
    */
    mockApi([AUTH_OK, CATEGORIES, meetingsRoute(rows)]);
    renderAt("/");

    await userEvent.click(
      await screen.findByRole("button", { name: "공유받은 회의 관리 메뉴" }),
    );
    expect(await screen.findByRole("menuitem", { name: "이름 변경" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "카테고리 이동" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "삭제" })).not.toBeInTheDocument();
  });

  it("내 회의 메뉴에는 삭제가 있다", async () => {
    mockApi([AUTH_OK, CATEGORIES, meetingsRoute(rows)]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "내 회의 관리 메뉴" }));
    expect(await screen.findByRole("menuitem", { name: "삭제" })).toBeInTheDocument();
  });
});

describe("공유 표시와 개인 이름", () => {
  it("[공유] 배지는 내가 이름을 바꿔도 그대로 남는다", async () => {
    /*
      "[공유] 회의명" as a string would live in the title, and the moment the
      recipient renamed it on their own screen the marker would go with it. It is
      permission — `is_owner` from the server — so an alias moves the words
      beside it and never the badge.
    */
    mockApi([
      AUTH_OK, CATEGORIES,
      meetingsRoute([
        meeting({
          id: 8, title: "프로젝트 킥오프", alias: "지오영 킥오프",
          is_owner: false, owner_user_id: 99, owner_display_name: "최광훈",
        }),
      ]),
    ]);
    renderAt("/");

    expect(await screen.findByText("지오영 킥오프")).toBeInTheDocument();
    expect(screen.getByText("공유")).toBeInTheDocument();
    // the marker is not text inside the name
    expect(screen.queryByText(/\[공유\]/)).not.toBeInTheDocument();
    expect(screen.queryByText("프로젝트 킥오프")).not.toBeInTheDocument();
  });

  it("검색해서 걸러도 배지는 붙어 있다", async () => {
    mockApi([
      AUTH_OK, CATEGORIES,
      meetingsRoute([
        meeting({ id: 7, title: "내 킥오프" }),
        meeting({
          id: 8, title: "공유 킥오프", is_owner: false,
          owner_user_id: 99, owner_display_name: "최광훈",
        }),
      ]),
    ]);
    renderAt("/?q=공유");

    expect(await screen.findByText("공유 킥오프")).toBeInTheDocument();
    expect(screen.getByText("공유")).toBeInTheDocument();
  });

  it("공유받은 회의 상세에서도 배지가 붙는다", async () => {
    mockApi([AUTH_OK, shared({ alias: "내가 붙인 이름" }), INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=overview");

    const header = await screen.findByRole("banner");
    expect(within(header).getByText("공유")).toBeInTheDocument();
    expect(within(header).getByRole("heading", { name: /내가 붙인 이름/ })).toBeInTheDocument();
  });
});

describe("생성 권한", () => {
  /* One policy, drawn one way. Both the summary and the facts are produced once
     per meeting and read by every reader, so both belong to the owner — and the
     server refuses either with 403. */
  it("공유받은 회의의 인사이트 탭에는 생성 버튼이 없다", async () => {
    mockApi([AUTH_OK, shared(), INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=intelligence");

    // Wait for the panel's own content, not just its title — the title is there
    // while the query is still in flight.
    expect(await screen.findByText(/소유자가 인사이트를 생성하면/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "인사이트 생성" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 생성" })).not.toBeInTheDocument();
  });

  it("소유자에게는 인사이트 생성 버튼이 있다", async () => {
    mockApi([AUTH_OK, owned(), INTEL, NO_SUMMARY, versionsRoute(), sharesRoute()]);
    renderAt("/meetings/7?tab=intelligence");

    expect(await screen.findByRole("button", { name: "인사이트 생성" })).toBeInTheDocument();
  });

  it("공유받은 회의의 개요에는 요약 생성 버튼이 없다", async () => {
    mockApi([AUTH_OK, shared(), INTEL, NO_SUMMARY]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByText(/소유자가 요약을 생성하면/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "요약 생성" })).not.toBeInTheDocument();
  });

  it("소유자에게는 요약 생성 버튼이 있다", async () => {
    mockApi([AUTH_OK, owned(), INTEL, NO_SUMMARY, versionsRoute(), sharesRoute()]);
    renderAt("/meetings/7?tab=overview");

    expect(await screen.findByRole("button", { name: "요약 생성" })).toBeInTheDocument();
  });
});

describe("공유 알림", () => {
  const INVITE = {
    id: 3, meeting_id: 7, created_at: "2026-08-22T01:00:00+00:00",
    meeting_title: "개발 주간회의", occurred_at: "2026-08-21T01:00:00+00:00",
    held_at_known: true, shared_by: "최광훈",
  };
  const WITH_INVITE = [
    AUTH_OK, CATEGORIES, meetingsRoute([]),
    { path: "/api/share-invitations", body: [INVITE] },
  ];

  /**
   * An invitation is a notification, not a destination. There is no
   * `/invitations` route any more: the count lives in the sidebar and answering
   * one happens in a dialog over whatever screen the reader was on.
   */
  it("사이드바에 대기 중인 알림 수를 표시한다", async () => {
    mockApi(WITH_INVITE);
    renderAt("/");
    expect(await screen.findByRole("button", { name: "공유 알림 1건 대기" })).toBeInTheDocument();
  });

  it("알림은 누가 무엇을 공유했는지만 말한다 — 승인 전에는 회의를 열 수 없다", async () => {
    mockApi(WITH_INVITE);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "공유 알림 1건 대기" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/최광훈/)).toBeInTheDocument();
    expect(dialog.getByText(/개발 주간회의/)).toBeInTheDocument();
    // no link into the meeting: it is unreachable until this is accepted
    expect(dialog.queryByRole("link")).not.toBeInTheDocument();
  });

  it("수락과 거절을 각각 서버에 보낸다", async () => {
    const calls = mockApi([
      ...WITH_INVITE,
      { method: "POST", path: "/api/share-invitations/3/accept", body: { status: "ACCEPTED" } },
      { method: "POST", path: "/api/share-invitations/3/reject", body: { status: "REJECTED" } },
    ]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "공유 알림 1건 대기" }));
    await userEvent.click(await screen.findByRole("button", { name: "수락" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/accept"))).toBe(true));

    await userEvent.click(await screen.findByRole("button", { name: "공유 알림 1건 대기" }));
    await userEvent.click(await screen.findByRole("button", { name: "거절" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/reject"))).toBe(true));
  });

  it("알림이 없으면 승인 전에는 볼 수 없다는 사실을 함께 말한다", async () => {
    mockApi([AUTH_OK, CATEGORIES, meetingsRoute([])]);
    renderAt("/");

    await userEvent.click(await screen.findByRole("button", { name: "공유 알림" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("받은 공유 초대가 없습니다.")).toBeInTheDocument();
    expect(dialog.getByText(/승인하기 전에는 회의를 열람할 수 없습니다/)).toBeInTheDocument();
  });
});

describe("검색 범위 선택", () => {
  it("내 회의와 공유받은 회의를 나눠서 고르게 한다", async () => {
    mockApi([
      AUTH_OK, CATEGORIES,
      { path: "/api/chat/sessions", body: [{ id: 1, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-22T00:00:00Z" }] },
      {
        path: "/api/chat/sessions/1",
        body: {
          session: { id: 1, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-22T00:00:00Z" },
          messages: [],
        },
      },
      meetingsRoute([
        meeting({ id: 7, title: "내 회의", is_owner: true }),
        meeting({ id: 8, title: "운영 회의", is_owner: false, owner_display_name: "김OO" }),
      ]),
    ]);
    renderAt("/chat/1");

    await userEvent.click(await screen.findByRole("button", { name: /범위 변경/ }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("내 회의 1개")).toBeInTheDocument();
    expect(within(dialog).getByText("공유받은 회의 1개")).toBeInTheDocument();
    expect(within(dialog).getByText(/김OO 공유/)).toBeInTheDocument();
    // each group can be taken in one click
    expect(within(dialog).getAllByRole("button", { name: "전체 선택" })).toHaveLength(2);
  });

  it("그룹 전체 선택은 그 그룹의 회의만 고른다", async () => {
    const calls = mockApi([
      AUTH_OK, CATEGORIES,
      { path: "/api/chat/sessions", body: [{ id: 1, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-22T00:00:00Z" }] },
      {
        path: "/api/chat/sessions/1",
        body: {
          session: { id: 1, title: "새 채팅", scope_meeting_ids: [], updated_at: "2026-08-22T00:00:00Z" },
          messages: [],
        },
      },
      meetingsRoute([
        meeting({ id: 7, title: "내 회의", is_owner: true }),
        meeting({ id: 8, title: "운영 회의", is_owner: false, owner_display_name: "김OO" }),
      ]),
      { method: "PATCH", path: "/api/chat/sessions/1", body: { id: 1, scope_meeting_ids: [8] } },
    ]);
    renderAt("/chat/1");

    await userEvent.click(await screen.findByRole("button", { name: /범위 변경/ }));
    const dialog = await screen.findByRole("dialog");
    const groups = within(dialog).getAllByRole("button", { name: "전체 선택" });
    await userEvent.click(groups[1]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));

    await waitFor(() => {
      const sent = calls.find((c) => c.method === "PATCH");
      expect(sent?.body).toEqual({ scope_meeting_ids: [8] });
    });
  });
});

describe("접근 권한을 잃은 근거", () => {
  it("인용 번호는 남기고 원문은 보여주지 않는다", async () => {
    mockApi([
      AUTH_OK, CATEGORIES,
      { path: "/api/chat/sessions", body: [{ id: 1, title: "대화", scope_meeting_ids: [], updated_at: "2026-08-22T00:00:00Z" }] },
      {
        path: "/api/chat/sessions/1",
        body: {
          session: { id: 1, title: "대화", scope_meeting_ids: [], updated_at: "2026-08-22T00:00:00Z" },
          messages: [
            question("SSL 인증서 누가 발급해?"),
            assistant("김대리가 발급합니다 [1]", [{
              index: 1, kind: "chunk", meeting_id: null,
              meeting_title: "접근 권한이 없는 회의", speakers: [],
              start_time: 0, end_time: 0, time_label: "", text: "", score: 0,
              revoked: true,
            }]),
          ],
        },
      },
    ]);
    renderAt("/chat/1");

    await userEvent.click(await screen.findByRole("button", { name: /출처 1개/ }));
    const panel = await screen.findByLabelText("출처");
    expect(within(panel).getByText("접근 권한이 없는 회의")).toBeInTheDocument();
    expect(within(panel).getByText(/근거 원문을 표시하지 않습니다/)).toBeInTheDocument();
    // nothing to open, because there is nothing this account may read
    expect(within(panel).queryByRole("link", { name: "회의록에서 보기" })).not.toBeInTheDocument();
  });
});
