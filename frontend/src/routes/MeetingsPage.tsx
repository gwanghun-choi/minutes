import { Mic, Plus, Search, Settings2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useCategories, useMeetings } from "../api/queries";
import type { MeetingListRow, MeetingStatus } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { MeetingStatusBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/controls";
import { EmptyState, ErrorState, SkeletonRows } from "../components/ui/feedback";
import { CategoryDialog } from "../features/meetings/CategoryDialog";
import { UploadDialog } from "../features/meetings/UploadDialog";
import { fmtDate, fmtTime } from "../lib/format";
import { MEETING_STATUS } from "../lib/labels";
import {
  EMPTY_QUERY, isFiltered, matches, meetingTime, RANGES, type MeetingQuery,
} from "../lib/meetings";

const STATUSES = Object.keys(MEETING_STATUS) as MeetingStatus[];

const SORTS = [
  { value: "held_desc", label: "회의 일시 최신순" },
  { value: "held_asc", label: "회의 일시 오래된순" },
  { value: "created_desc", label: "등록 최신순" },
] as const;

type SortId = (typeof SORTS)[number]["value"];

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

/** One active filter, removable where it is shown. */
function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-muted py-0.5 pr-1 pl-2 text-xs text-fg-muted">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`${label} 필터 해제`}
        className="rounded p-0.5 hover:bg-border hover:text-fg"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

export function MeetingsPage() {
  const { data, isPending, isError, error, refetch } = useMeetings();
  const categories = useCategories();
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [query, setQuery] = useState<MeetingQuery>(EMPTY_QUERY);
  const [days, setDays] = useState(0);
  const [sort, setSort] = useState<SortId>("held_desc");

  const rows = useMemo(() => {
    const out = (data ?? []).filter((m) => matches(m, query));
    return out.sort((a, b) =>
      sort === "created_desc"
        ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        : sort === "held_asc"
          ? meetingTime(a) - meetingTime(b)
          : meetingTime(b) - meetingTime(a),
    );
  }, [data, query, sort]);

  const filtered = isFiltered(query);
  const categoryLabel =
    query.category === "none"
      ? "미분류"
      : (categories.data ?? []).find((k) => String(k.id) === query.category)?.name;
  const clearRange = () => {
    setDays(0);
    setQuery((q) => ({ ...q, cutoff: null }));
  };

  return (
    <>
      <PageHeader
        title="회의"
        meta={
          data ? (
            <span>
              {filtered ? `${rows.length} / ${data.length}개` : `${data.length}개`}
            </span>
          ) : null
        }
        actions={
          <Button variant="primary" onClick={() => setUploadOpen(true)} icon={<Plus className="size-4" />}>
            회의 업로드
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-6xl px-5 py-4">
        {/* One toolbar, not four controls scattered across the page. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query.text}
              onChange={(e) => setQuery({ ...query, text: e.target.value })}
              placeholder="회의명 또는 파일명 검색"
              aria-label="회의 검색"
              className="pl-8"
            />
          </div>
          <Select
            value={query.category}
            onChange={(e) => setQuery({ ...query, category: e.target.value })}
            aria-label="카테고리로 거르기"
            className="w-36"
          >
            <option value="">모든 카테고리</option>
            <option value="none">미분류</option>
            {(categories.data ?? []).map((k) => (
              <option key={k.id} value={String(k.id)}>
                {k.name}
              </option>
            ))}
          </Select>
          <Select
            value={query.status}
            onChange={(e) => setQuery({ ...query, status: e.target.value })}
            aria-label="상태로 거르기"
            className="w-32"
          >
            <option value="">모든 상태</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {MEETING_STATUS[s]}
              </option>
            ))}
          </Select>
          <Select
            value={String(days)}
            onChange={(e) => {
              const next = Number(e.target.value);
              setDays(next);
              setQuery({ ...query, cutoff: next ? Date.now() - next * 86_400_000 : null });
            }}
            aria-label="기간으로 거르기"
            className="w-32"
          >
            {RANGES.map((r) => (
              <option key={r.days} value={String(r.days)}>
                {r.label}
              </option>
            ))}
          </Select>
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            aria-label="정렬"
            className="w-40"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setManageOpen(true)}
            icon={<Settings2 aria-hidden className="size-4" />}
          >
            카테고리 관리
          </Button>
        </div>

        {filtered ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {query.text.trim() ? (
              <Chip
                label={`"${query.text.trim()}"`}
                onClear={() => setQuery((q) => ({ ...q, text: "" }))}
              />
            ) : null}
            {categoryLabel ? (
              <Chip
                label={categoryLabel}
                onClear={() => setQuery((q) => ({ ...q, category: "" }))}
              />
            ) : null}
            {query.status ? (
              <Chip
                label={MEETING_STATUS[query.status as MeetingStatus]}
                onClear={() => setQuery((q) => ({ ...q, status: "" }))}
              />
            ) : null}
            {query.cutoff !== null ? (
              <Chip
                label={RANGES.find((r) => r.days === days)?.label ?? "기간"}
                onClear={clearRange}
              />
            ) : null}
            <button
              type="button"
              onClick={() => {
                setQuery(EMPTY_QUERY);
                setDays(0);
              }}
              className="ml-1 text-xs font-medium text-fg-muted hover:text-fg hover:underline"
            >
              필터 초기화
            </button>
          </div>
        ) : null}

        <div className="mt-3 overflow-hidden rounded border border-border bg-surface">
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
              icon={<Mic className="size-6" />}
              title={
                data?.length
                  ? "조건에 맞는 회의가 없습니다."
                  : "아직 등록된 회의가 없습니다."
              }
              hint={
                data?.length
                  ? "검색어나 필터를 바꿔 보세요."
                  : "회의 음성을 올리면 회의록·요약·구조화 정보를 만들어 드립니다."
              }
              action={
                data?.length ? (
                  <Button
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      setQuery(EMPTY_QUERY);
                      setDays(0);
                    }}
                  >
                    필터 초기화
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" className="mt-2" onClick={() => setUploadOpen(true)}>
                    회의 업로드
                  </Button>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-fg-muted">
                    <th scope="col" className="px-4 py-2">회의명</th>
                    <th scope="col" className="px-4 py-2">카테고리</th>
                    <th scope="col" className="px-4 py-2">회의 일시</th>
                    <th scope="col" className="px-4 py-2">재생시간</th>
                    <th scope="col" className="px-4 py-2">화자</th>
                    <th scope="col" className="px-4 py-2">상태</th>
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
                      <td className="px-4 py-2">
                        <div className="font-medium text-fg">{m.title}</div>
                        {/* Secondary metadata, deliberately quiet. */}
                        <div className="text-xs text-fg-subtle">{m.original_filename}</div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-fg-muted">
                        {m.category_name ?? <span className="text-fg-subtle">미분류</span>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-fg-muted">
                        <MeetingDate meeting={m} />
                      </td>
                      <td className="px-4 py-2 tabular-nums whitespace-nowrap text-fg-muted">
                        {fmtTime(m.duration)}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-fg-muted">
                        {m.speaker_count || "-"}
                      </td>
                      <td className="px-4 py-2">
                        <MeetingStatusBadge status={m.status} />
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
      <CategoryDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  );
}
