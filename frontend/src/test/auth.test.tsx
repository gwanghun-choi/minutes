import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_401, AUTH_OK, mockApi, renderAt } from "./harness";

afterEach(() => vi.unstubAllGlobals());

describe("인증", () => {
  it("로그인하지 않으면 어떤 화면을 열어도 로그인 폼이 나온다", async () => {
    mockApi([AUTH_401]);
    renderAt("/meetings/7");
    expect(await screen.findByLabelText("아이디")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
  });

  it("아이디나 비밀번호가 틀리면 서버가 준 문구를 그대로 보여준다", async () => {
    mockApi([
      AUTH_401,
      {
        method: "POST", path: "/api/auth/login", status: 401,
        body: { detail: "아이디 또는 비밀번호가 올바르지 않습니다." },
      },
    ]);
    renderAt("/login");

    await userEvent.type(await screen.findByLabelText("아이디"), "nobody");
    await userEvent.type(screen.getByLabelText("비밀번호"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "아이디 또는 비밀번호가 올바르지 않습니다.",
    );
  });

  it("로그인에 성공하면 원래 가려던 화면으로 돌아간다", async () => {
    let signedIn = false;
    mockApi([
      {
        path: "/api/auth/me",
        reply: () =>
          signedIn
            ? { body: { id: 1, username: "tester", display_name: "테스터" } }
            : { status: 401, body: { detail: "로그인이 필요합니다." } },
      },
      {
        method: "POST", path: "/api/auth/login",
        reply: () => {
          signedIn = true;
          return { body: { username: "tester", display_name: "테스터" } };
        },
      },
      { path: "/api/meetings", body: [] },
    ]);
    renderAt("/meetings");

    await userEvent.type(await screen.findByLabelText("아이디"), "tester");
    await userEvent.type(screen.getByLabelText("비밀번호"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));

    expect(await screen.findByRole("heading", { name: "회의" })).toBeInTheDocument();
  });

  it("로그인한 사용자 이름은 서버에서 온다", async () => {
    mockApi([AUTH_OK, { path: "/api/meetings", body: [] }]);
    renderAt("/");
    expect(await screen.findAllByText("테스터")).not.toHaveLength(0);
  });

  it("로그아웃하면 서버 세션을 지우고 로그인 화면으로 돌아간다", async () => {
    let signedIn = true;
    const calls = mockApi([
      {
        path: "/api/auth/me",
        reply: () =>
          signedIn
            ? { body: { id: 1, username: "tester", display_name: "테스터" } }
            : { status: 401, body: { detail: "로그인이 필요합니다." } },
      },
      { path: "/api/meetings", body: [] },
      {
        method: "POST", path: "/api/auth/logout",
        reply: () => {
          signedIn = false;
          return { body: { ok: true } };
        },
      },
    ]);
    renderAt("/");

    await userEvent.click((await screen.findAllByRole("button", { name: "로그아웃" }))[0]!);
    await waitFor(() => expect(screen.getByLabelText("아이디")).toBeInTheDocument());
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/auth/logout")).toBe(true);
  });
});
