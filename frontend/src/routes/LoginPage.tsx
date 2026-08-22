import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import { errorMessage } from "../api/client";
import { useLogin, useMe } from "../api/queries";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/controls";
import { Spinner } from "../components/ui/feedback";

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
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  // A refresh restores the session from the server, so an already-signed-in
  // visitor never sees this form.
  if (me) return <Navigate to={from} replace />;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <form
        className="w-full max-w-sm rounded-md border border-border bg-surface p-6"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate({ username, password }, { onSuccess: () => navigate(from, { replace: true }) });
        }}
      >
        <h1 className="text-xl font-semibold tracking-tight text-fg">Minutes</h1>
        <p className="mt-1 mb-6 text-xs text-fg-muted">회의 음성을 회의록과 검색 가능한 정보로.</p>

        <div className="flex flex-col gap-3">
          <Field label="아이디">
            <Input
              className="w-full"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </Field>
          <Field label="비밀번호">
            <Input
              className="w-full"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
        </div>

        {login.isError ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {errorMessage(login.error)}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          className="mt-5 w-full"
          loading={login.isPending}
        >
          로그인
        </Button>
      </form>
    </div>
  );
}
