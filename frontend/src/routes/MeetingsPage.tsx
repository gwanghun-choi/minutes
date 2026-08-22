import { ArrowUpDown, ChevronLeft, ChevronRight, Mic, Plus, Search, Settings2, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { useCategories, useDeleteMeeting, useMeetings } from "../api/queries";
import type { MeetingListRow, MeetingStatus } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { MeetingStatusBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/Dialog";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Input, Select } from "../components/ui/controls";
import { EmptyState, ErrorState, SkeletonRows } from "../components/ui/feedback";
import { UploadDialog } from "../features/meetings/UploadDialog";
import { fmtDate, fmtTime } from "../lib/format";
import { MEETING_STATUS } from "../lib/labels";
import {
  categoryLabel, isFiltered, PAGE_SIZES, RANGES, SORTS, toParams,
  type MeetingQuery, type MeetingSort,
} from "../lib/meetings";

const STATUSES = Object.keys(MEETING_STATUS) as MeetingStatus[];
const DEFAULT_SIZE = PAGE_SIZES[0]!;

/**
 * The list's whole state lives in the URL.
 *
 * Not for shareable links (though they are), but because two things drive it: the
 * toolbar here and the category tree in the sidebar, which is mounted outside
 * this route. The URL is the one place both can write to without a store — and
 * the app is explicitly not getting one for two screens.
 */
function useListState() {
  const [params, setParams] = useSearchParams();
  const size = Number(params.get("size"));

  const state = {
    query: {
      text: params.get("q") ?? "",
      category: params.get("category") ?? "",
      status: params.get("status") ?? "",
      days: Number(params.get("days")) || 0,
    } satisfies MeetingQuery,
    sort: (SORTS.find((s) => s.value === params.get("sort"))?.value ?? "held_desc") as MeetingSort,
    page: Math.max(1, Number(params.get("page")) || 1),
    size: PAGE_SIZES.includes(size) ? size : DEFAULT_SIZE,
  };

  /**
   * Write some of it back. Anything empty leaves the URL rather than sitting in
   * it as `&status=`, and changing a filter returns to page 1 — page 3 of a
   * narrower list is usually not there any more.
   */
  const update = (
    changes: Record<string, string | number | null>,
    keepPage = false,
  ) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "" || value === 0) next.delete(key);
      else next.set(key, String(value));
    }
    if (!keepPage) next.delete("page");
    setParams(next, { replace: true });
  };

  return { ...state, update };
}

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

/**
 * Which slice of the filtered set is on screen, and how to move.
 *
 * `total` is the server's count for the filter, not the page's length, so the
 * numbers stay honest when a filter narrows the set under an open page.
 */
function Pager({
  page, size, total, onPage, onSize,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-xs text-fg-muted" aria-live="polite">
        총 {total}개 중 {from}–{to}
      </span>
      <label className="flex items-center gap-1.5 text-xs text-fg-muted">
        페이지당
        <Select
          value={String(size)}
          onChange={(e) => onSize(Number(e.target.value))}
          aria-label="페이지당 개수"
          className="h-7 w-auto py-0 text-xs"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={String(n)}>
              {n}개
            </option>
          ))}
        </Select>
      </label>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          size="sm"
          aria-label="이전 페이지"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          icon={<ChevronLeft aria-hidden className="size-4" />}
        />
        <span className="text-xs tabular-nums text-fg-muted">
          {page} / {pages}
        </span>
        <Button
          size="sm"
          aria-label="다음 페이지"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          icon={<ChevronRight aria-hidden className="size-4" />}
        />
      </div>
    </div>
  );
}

export function MeetingsPage() {
  const { query, sort, page, size, update } = useListState();
  const { data, isPending, isError, error, refetch } = useMeetings({
    ...toParams(query), sort, page, page_size: size,
  });
  const categories = useCategories();
  const remove = useDeleteMeeting();
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [doomed, setDoomed] = useState<MeetingListRow | null>(null);

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = isFiltered(query);
  const clearAll = () =>
    update({ q: null, category: null, status: null, days: null, page: null });

  return (
    <>
      <PageHeader
        title="회의"
        meta={data ? <span>{filtered ? `조건에 맞는 ${total}개` : `${total}개`}</span> : null}
        actions={
          <Button variant="primary" onClick={() => setUploadOpen(true)} icon={<Plus className="size-4" />}>
            회의 업로드
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-6xl px-5 py-4">
        {/*
          One compact toolbar: search is the control that gets used, so it leads
          and the rest are fixed-width selects beside it rather than four
          full-width rows. Sort is pushed right — it changes the order, not what
          is in the list, so it is not a filter.
        */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <div className="relative w-full min-w-48 sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query.text}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="회의명 또는 파일명 검색"
              aria-label="회의 검색"
              className="h-8 w-full pl-8"
            />
          </div>
          <Select
            value={query.category}
            onChange={(e) => update({ category: e.target.value })}
            aria-label="카테고리로 거르기"
            className="h-8 w-auto min-w-32"
          >
            <option value="">모든 카테고리</option>
            <option value="none">미분류</option>
            {/* The path, so a child is never ambiguous, and hierarchy order —
                the server already returns the tree pre-ordered. */}
            {(categories.data ?? []).map((k) => (
              <option key={k.id} value={String(k.id)}>
                {k.path}
              </option>
            ))}
          </Select>
          <Select
            value={query.status}
            onChange={(e) => update({ status: e.target.value })}
            aria-label="상태로 거르기"
            className="h-8 w-auto min-w-28"
          >
            <option value="">모든 상태</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {MEETING_STATUS[s]}
              </option>
            ))}
          </Select>
          <Select
            value={String(query.days)}
            onChange={(e) => update({ days: Number(e.target.value) })}
            aria-label="기간으로 거르기"
            className="h-8 w-auto min-w-28"
          >
            {RANGES.map((r) => (
              <option key={r.days} value={String(r.days)}>
                {r.label}
              </option>
            ))}
          </Select>

          <div className="ml-auto flex items-center gap-1.5">
            <ArrowUpDown aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
            <Select
              value={sort}
              onChange={(e) => update({ sort: e.target.value })}
              aria-label="정렬"
              className="h-8 w-auto min-w-36"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {filtered ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {query.text.trim() ? (
              <Chip label={`"${query.text.trim()}"`} onClear={() => update({ q: null })} />
            ) : null}
            {categoryLabel(query.category, categories.data) ? (
              <Chip
                label={categoryLabel(query.category, categories.data)!}
                onClear={() => update({ category: null })}
              />
            ) : null}
            {query.status ? (
              <Chip
                label={MEETING_STATUS[query.status as MeetingStatus]}
                onClear={() => update({ status: null })}
              />
            ) : null}
            {query.days > 0 ? (
              <Chip
                label={RANGES.find((r) => r.days === query.days)?.label ?? "기간"}
                onClear={() => update({ days: null })}
              />
            ) : null}
            <button
              type="button"
              onClick={clearAll}
              className="ml-1 text-xs font-medium text-fg-muted hover:text-fg hover:underline"
            >
              필터 초기화
            </button>
          </div>
        ) : null}

        <div className="mt-3 overflow-hidden rounded-md border border-border bg-surface shadow-panel">
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
                filtered
                  ? "조건에 맞는 회의가 없습니다."
                  : "아직 등록된 회의가 없습니다."
              }
              hint={
                filtered
                  ? "검색어나 필터를 바꿔 보세요."
                  : "회의 음성을 올리면 회의록·요약·구조화 정보를 만들어 드립니다."
              }
              action={
                filtered ? (
                  <Button size="sm" className="mt-2" onClick={clearAll}>
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
                    <th scope="col" className="px-2 py-2">
                      <span className="sr-only">관리</span>
                    </th>
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
                      {/* The row is a link, so the menu has to stop the click
                          from also navigating. */}
                      <td
                        className="px-2 py-2"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Menu label={`${m.title} 관리 메뉴`}>
                          <MenuItem
                            destructive
                            onSelect={() => setDoomed(m)}
                            icon={<Trash2 aria-hidden className="size-4" />}
                          >
                            삭제
                          </MenuItem>
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {data && total > 0 ? (
          <Pager
            page={page}
            size={size}
            total={total}
            onPage={(next) => update({ page: next }, true)}
            onSize={(next) => update({ size: next })}
          />
        ) : null}

        {/* Management, one step quieter than the filters that use it. */}
        <div className="mt-2.5 flex justify-end">
          <Link
            to="/categories"
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg hover:underline"
          >
            <Settings2 aria-hidden className="size-3.5" />
            카테고리 관리
          </Link>
        </div>
      </div>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />

      {/* One delete path for the list, the same endpoint the detail page uses.
          The server re-checks nothing about status because there is nothing to
          check: any meeting can go. */}
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => !open && setDoomed(null)}
        title="이 회의를 삭제할까요?"
        confirmLabel="삭제"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (!doomed || remove.isPending) return;
          remove.mutate(doomed.id, {
            onSuccess: () => {
              toast.success("회의를 삭제했습니다.");
              setDoomed(null);
            },
            onError: (err) => toast.error("삭제 실패", { description: err.message }),
          });
        }}
        body={
          <>
            <strong className="text-fg">{doomed?.title}</strong> 의 회의록, 검색 인덱스,
            인사이트, 업로드한 음성이 모두 삭제됩니다.
            <br />
            되돌릴 수 없습니다.
          </>
        }
      />
    </>
  );
}
