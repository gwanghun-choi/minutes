import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import { errorMessage } from "../api/client";
import { useLogin, useMe } from "../api/queries";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/controls";
import { Spinner } from "../components/ui/feedback";

/**
 * The sign-in screen, and nothing else.
 *
 * Two panels from `md`: the product on the left, the form on the right. The left
 * panel exists so the page has a subject and the form has a size — a lone card
 * floating in the middle of an empty viewport is what made this look like an
 * exercise. What is on it is a wordmark and one sentence about what Minutes is.
 *
 * Deliberately absent: figures nobody measured, quotes nobody said, an
 * illustration of a meeting. This is an internal tool; the person here already
 * knows what it is and came to type two fields.
 *
 * Below `md` the left panel becomes a short header above the form, so a phone
 * gets the same page rather than a different one.
 */
export function LoginPage() {
  const { data: me, isPending } = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner className="size-6" />
        <span className="sr-only">불러오는 중</span>
      </div>
    );
  }
  // A refresh restores the session from the server, so an already-signed-in
  // visitor never sees this form.
  if (me) return <Navigate to={from} replace />;

  return (
    <div className="min-h-dvh bg-bg md:grid md:grid-cols-[1.1fr_1fr] lg:grid-cols-[1.25fr_1fr]">
      <section className="flex flex-col justify-between gap-8 bg-fg px-6 py-8 text-surface sm:px-10 md:py-12 lg:px-16">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-surface text-[13px] font-bold text-fg">
            M
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Minutes</span>
        </div>

        <div className="max-w-md">
          <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] md:text-[28px]">
            회의 음성을 회의록과
            <br />
            검색 가능한 근거로.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-surface/70">
            녹음을 올리면 화자별 회의록을 만들고, 사람이 승인한 회의록만 검색과 답변의 근거가
            됩니다.
          </p>
        </div>

        <p className="text-[11px] text-surface/40">사내 계정으로 로그인합니다.</p>
      </section>

      <section className="flex items-center justify-center px-6 py-10 sm:px-10 md:py-12">
        <form
          className="w-full max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate({ username, password }, { onSuccess: () => navigate(from, { replace: true }) });
          }}
        >
          <h2 className="text-lg font-semibold tracking-tight text-fg">로그인</h2>
          <p className="mt-1 text-xs text-fg-muted">계정 정보를 입력해 주세요.</p>

          <div className="mt-6 flex flex-col gap-3.5">
            <Field label="아이디">
              <Input
                className="h-10 w-full"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label="비밀번호">
              <Input
                className="h-10 w-full"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          </div>

          {login.isError ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger"
            >
              {errorMessage(login.error)}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="mt-5 h-10 w-full"
            loading={login.isPending}
          >
            로그인
          </Button>
        </form>
      </section>
    </div>
  );
}
