import { Link } from "react-router";

import { PageBody, PageHeader } from "../components/AppShell";

export function NotFoundPage() {
  return (
    <>
      {/* Inside the shell like every other screen, so the sidebar and the
          top-right utilities are still there to leave with. */}
      <PageHeader title="페이지를 찾을 수 없습니다" />
      <PageBody max="max-w-md">
        <p className="text-xs font-medium text-fg-subtle">404</p>
        <p className="mt-1 text-sm text-fg-muted">
          주소가 바뀌었거나, 삭제된 회의일 수 있습니다.
        </p>
        <Link to="/" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
          회의 목록으로 돌아가기
        </Link>
      </PageBody>
    </>
  );
}
