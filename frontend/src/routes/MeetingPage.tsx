import clsx from "clsx";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { useMeeting } from "../api/queries";
import type { MeetingDetail } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { MeetingStatusBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Panel } from "../components/ui/Panel";
import { ErrorState, Spinner } from "../components/ui/feedback";
import { CategoryField } from "../features/meetings/CategoryField";
import { DangerZone } from "../features/meetings/DangerZone";
import { HeldAtField } from "../features/meetings/HeldAtField";
import { PendingNotice } from "../features/meetings/PendingNotice";
import { IntelligencePanel } from "../features/meetings/IntelligencePanel";
import { SharePanel } from "../features/meetings/SharePanel";
import { SpeakerBar } from "../features/meetings/SpeakerBar";
import { SummaryPanel } from "../features/meetings/SummaryPanel";
import { TranscriptPanel } from "../features/meetings/TranscriptPanel";
import { VersionPanel } from "../features/meetings/VersionPanel";
import { fmtDate, fmtTime } from "../lib/format";

const TABS = [
  { id: "overview", label: "개요" },
  { id: "transcript", label: "회의록" },
  { id: "intelligence", label: "인사이트" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function MeetingPage() {
  const meetingId = Number(useParams().meetingId);
  const [params, setParams] = useSearchParams();
  /* `?version=` is how the version panel and the transcript agree on which
     revision is on screen. Omitted, the server picks the one that matters to
     this account — the draft an owner is editing, the published minutes for a
     shared reader, who cannot ask for anything else. */
  const wanted = Number(params.get("version")) || undefined;
  const { data, isPending, isError, error } = useMeeting(meetingId, wanted);
  const navigate = useNavigate();

  if (isPending) {
    return (
      <div className="flex items-center gap-2 px-5 py-8 text-sm text-fg-muted">
        <Spinner /> 회의를 불러오는 중…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="px-5 py-6">
        <ErrorState
          error={error}
          action={
            <Link to="/" className="text-sm font-medium text-primary hover:underline">
              회의 목록으로
            </Link>
          }
        />
      </div>
    );
  }

  const meeting = data.meeting;
  const owner = data.role === "OWNER";
  const approved = meeting.status === "COMPLETED";
  /* Editable means: this account owns it, and the revision on screen is the one
     that is open for editing. Both are the server's answers — it refuses the
     PATCH on the same two conditions. */
  const editing = owner && data.draft_version !== null && data.version === data.draft_version;
  const review = meeting.status === "REVIEW_REQUIRED";
  // A meeting waiting on review opens on the thing the reviewer came to do.
  const tab = (params.get("tab") as TabId | null) ?? (review ? "transcript" : "overview");

  return (
    <>
      <PageHeader
        back={
          <Link
            to="/"
            aria-label="회의 목록으로"
            className="mt-1.5 text-fg-subtle hover:text-fg"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
        }
        title={meeting.title}
        meta={
          <>
            <MeetingStatusBadge status={meeting.status} />
            {owner ? null : (
              <span className="text-primary">공유받은 회의 · {meeting.owner_display_name}</span>
            )}
            {data.active_version && data.active_version > 1 ? (
              <span>v{data.active_version}</span>
            ) : null}
            {meeting.category_name ? <span>{meeting.category_name}</span> : null}
            <span>
              {meeting.held_at ? (
                fmtDate(meeting.held_at)
              ) : (
                <span className="text-fg-subtle">{fmtDate(meeting.created_at)} 등록</span>
              )}
            </span>
            <span className="tabular-nums">{fmtTime(meeting.duration)}</span>
            <span>{meeting.language ?? "언어 미상"}</span>
            <span>화자 {data.speakers.length || "-"}</span>
          </>
        }
        actions={
          approved ? (
            <Button
              variant="secondary"
              icon={<MessagesSquare className="size-4" />}
              onClick={() => navigate(`/chat?meeting_id=${meeting.id}`)}
            >
              이 회의에 질문하기
            </Button>
          ) : null
        }
      />

      {meeting.error_message ? (
        <div className="px-5 pt-4">
          <ErrorState error={new Error(meeting.error_message)} />
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-5xl px-5 py-5">
        {data.speakers.length > 0 ? (
          <div className="mb-4">
            <SpeakerBar
              meetingId={meetingId}
              speakers={data.speakers}
              editable={editing}
              mySpeakerId={data.my_speaker_id}
            />
            <p className="mt-1.5 text-xs text-fg-subtle">
              {editing
                ? "화자 이름은 수정 중인 버전에서만 바꿀 수 있습니다. [나로 지정]은 언제든 바꿀 수 있습니다."
                : "[나로 지정]을 해 두면 채팅에서 “내가 요청한 것”을 물어볼 수 있습니다. 공유받은 회의라도 직접 지정해야 합니다."}
            </p>
          </div>
        ) : null}

        <div role="tablist" aria-label="회의 상세" className="mb-4 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setParams({ tab: t.id }, { replace: true })}
              className={clsx(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-fg-muted hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "overview" ? (
          <Overview
            detail={data}
            approved={approved}
            onReview={() => setParams({ tab: "transcript" })}
          />
        ) : null}
        {tab === "transcript" ? (
          <TranscriptPanel
            key={`${meetingId}:${data.version}:${meeting.status}`}
            detail={data}
            editable={editing}
          />
        ) : null}
        {tab === "intelligence" ? (
          <IntelligencePanel meetingId={meetingId} approved={approved} status={meeting.status} />
        ) : null}
      </div>
    </>
  );
}

function Overview({
  detail, approved, onReview,
}: { detail: MeetingDetail; approved: boolean; onReview: () => void }) {
  const m = detail.meeting;
  const owner = detail.role === "OWNER";
  return (
    <div className="space-y-4">
      <Panel title="회의 정보">
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          {/* Both of these are the owner's metadata about their own meeting —
              held_at moves it in every reader's chronology, and the category is
              the owner's filing. A shared reader reads them; the server refuses
              the write either way. */}
          {owner ? (
            <>
              <HeldAtField key={m.held_at ?? ""} meetingId={m.id} heldAt={m.held_at} />
              <CategoryField meetingId={m.id} categoryId={m.category_id} />
            </>
          ) : (
            <dl className="grid min-w-52 grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-xs text-fg-muted">회의 일시</dt>
              <dd className="text-fg">
                {m.held_at ? fmtDate(m.held_at) : <span className="text-fg-subtle">미입력</span>}
              </dd>
              <dt className="text-xs text-fg-muted">카테고리</dt>
              <dd className="text-fg">{m.category_name ?? "미분류"}</dd>
              <dt className="text-xs text-fg-muted">공유자</dt>
              <dd className="text-fg">{m.owner_display_name ?? "-"}</dd>
            </dl>
          )}
          <dl className="grid min-w-52 grid-cols-[3.5rem_1fr] gap-x-3 gap-y-1.5 self-end text-sm">
            <dt className="text-xs text-fg-muted">파일</dt>
            <dd className="truncate text-fg" title={m.original_filename}>
              {m.original_filename}
            </dd>
            <dt className="text-xs text-fg-muted">등록</dt>
            <dd className="text-fg-muted">{fmtDate(m.created_at)}</dd>
          </dl>
        </div>
      </Panel>

      {/* Before approval this is not a loading state and not an error — it is a
          meeting waiting on a person. Say which person-action is next. */}
      {approved ? (
        <SummaryPanel meetingId={m.id} approved={approved} canGenerate={owner} />
      ) : (
        <Panel title="회의 요약" bodyClassName="">
          <PendingNotice
            status={m.status}
            title="아직 생성된 요약이 없습니다."
            action={
              m.status === "REVIEW_REQUIRED" ? (
                <Button size="sm" variant="primary" className="mt-1" onClick={onReview}>
                  회의록 검토하기
                </Button>
              ) : null
            }
          />
        </Panel>
      )}

      {/* Version history is read-only for a shared reader and the whole revision
          workflow for an owner, so it is one panel with the buttons gated inside
          it rather than two panels saying the same thing. */}
      {approved ? (
        <Panel
          title="버전"
          description="승인된 회의록은 새 버전으로만 수정합니다. 수정하는 동안에도 검색은 현재 버전을 사용합니다."
        >
          <VersionPanel detail={detail} />
        </Panel>
      ) : null}

      {/* Sharing is the owner's alone — the endpoints behind it refuse everyone
          else, and even the number of readers is not a shared reader's business. */}
      {owner && approved ? (
        <Panel title="공유" description="초대한 사용자가 승인해야 열람할 수 있습니다. 읽기와 검색만 가능합니다.">
          <SharePanel meetingId={m.id} />
        </Panel>
      ) : null}

      {owner ? <DangerZone meeting={m} sharedWith={detail.shared_with ?? 0} /> : null}
    </div>
  );
}
