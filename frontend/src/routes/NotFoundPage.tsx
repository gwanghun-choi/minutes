import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-2 px-6 py-20">
      <p className="text-xs font-medium text-fg-subtle">404</p>
      <h1 className="text-lg font-semibold text-fg">페이지를 찾을 수 없습니다.</h1>
      <Link to="/" className="text-sm font-medium text-primary hover:underline">
        회의 목록으로 돌아가기
      </Link>
    </div>
  );
}
