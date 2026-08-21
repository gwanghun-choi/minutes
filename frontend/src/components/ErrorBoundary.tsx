import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "./ui/Button";

interface State {
  error: Error | null;
}

/**
 * A render error in one route must not leave a blank page. React has no hook
 * form of this, so it stays the one class component in the app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("화면을 그리는 중 오류가 발생했습니다.", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto flex max-w-md flex-col items-start gap-3 px-6 py-16">
        <h1 className="text-base font-semibold text-fg">화면을 표시할 수 없습니다.</h1>
        <p className="text-sm text-fg-muted">{this.state.error.message}</p>
        <Button variant="primary" size="sm" onClick={() => location.reload()}>
          새로고침
        </Button>
      </div>
    );
  }
}
