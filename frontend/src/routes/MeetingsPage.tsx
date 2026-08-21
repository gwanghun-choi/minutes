import { Mic, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useMeetings } from "../api/queries";
import type { MeetingListRow, MeetingStatus } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { Badge, MeetingStatusBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/controls";
import { EmptyState, ErrorState, SkeletonRows } from "../components/ui/feedback";
import { UploadDialog } from "../features/meetings/UploadDialog";
import { fmtDate, fmtTime } from "../lib/format";
import { MEETING_STATUS } from "../lib/labels";

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "모든 상태" },
  ...(Object.keys(MEETING_STATUS) as MeetingStatus[]).map((s) => ({
    value: s,
    label: MEETING_STATUS[s],
  })),
];

/** held_at is the meeting; created_at is only the upload. Never show the second
 *  as if it were the first. */
function MeetingDate({ meeting }: { meeting: MeetingListRow }) {
  if (meeting.held_at) return <span>{fmtDate(meeting.held_at)}</span>;
  return (
    <span className="text-fg-subtle" title="실제 회의 일시가 아직 입력되지 않았습니다.">
      {fmtDate(meeting.created_at)} 등록
    </span>
  );
}

export function MeetingsPage() {
  const { data, isPending, isError, error, refetch } = useMeetings();
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (m) =>
        (!q || m.title.toLowerCase().includes(q) || m.original_filename.toLowerCase().includes(q)) &&
        (!status || m.status === status),
    );
  }, [data, query, status]);

  return (
    <>
      <PageHeader
        title="회의"
        meta={data ? <span>{data.length}개</span> : null}
        actions={
          <Button variant="primary" onClick={() => setUploadOpen(true)} icon={<Plus className="size-4" />}>
            회의 업로드
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-6xl px-5 py-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="회의명 또는 파일명 검색"
              aria-label="회의 검색"
              className="pl-8"
            />
          </div>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="상태로 거르기"
            className="w-40"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="overflow-hidden rounded-panel border border-border bg-surface">
          {isPending ? (
            <SkeletonRows rows={5} className="p-4" />
          ) : isError ? (
            <div className="p-4">
              <ErrorState
                error={error}
                action={
                  <Button size="sm" onClick={() => void refetch()}>
                    다시 시도
                  </Button>
                }
              />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Mic className="size-7" />}
              title={data?.length ? "조건에 맞는 회의가 없습니다." : "아직 회의가 없습니다."}
              hint={
                data?.length
                  ? "검색어나 상태 필터를 바꿔 보세요."
                  : "회의 음성을 올리면 회의록·요약·구조화 정보를 만들어 드립니다."
              }
              action={
                data?.length ? null : (
                  <Button variant="primary" size="sm" className="mt-2" onClick={() => setUploadOpen(true)}>
                    회의 업로드
                  </Button>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-fg-muted">
                    <th scope="col" className="px-4 py-2.5">회의명</th>
                    <th scope="col" className="px-4 py-2.5">회의 일시</th>
                    <th scope="col" className="px-4 py-2.5">재생시간</th>
                    <th scope="col" className="px-4 py-2.5">화자</th>
                    <th scope="col" className="px-4 py-2.5">상태</th>
                    <th scope="col" className="px-4 py-2.5">인사이트</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr
                      key={m.id}
                      tabIndex={0}
                      role="link"
                      aria-label={`${m.title} 상세 보기`}
                      onClick={() => navigate(`/meetings/${m.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/meetings/${m.id}`);
                        }
                      }}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted focus-visible:bg-surface-muted"
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-fg">{m.title}</div>
                        <div className="text-xs text-fg-subtle">{m.original_filename}</div>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-fg-muted">
                        <MeetingDate meeting={m} />
                      </td>
                      <td className="px-4 py-2.5 tabular-nums whitespace-nowrap text-fg-muted">
                        {fmtTime(m.duration)}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-fg-muted">
                        {m.speaker_count || "-"}
                      </td>
                      <td className="px-4 py-2.5">
                        <MeetingStatusBadge status={m.status} />
                      </td>
                      <td className="px-4 py-2.5">
                        {m.intelligence_state === "READY" ? (
                          <Badge tone="success">준비됨</Badge>
                        ) : m.intelligence_state === "BUILDING" ? (
                          <Badge tone="info">생성 중</Badge>
                        ) : m.intelligence_state === "FAILED" ? (
                          <Badge tone="danger">실패</Badge>
                        ) : (
                          <span className="text-xs text-fg-subtle">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </>
  );
}
