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
import { SpeakerBar } from "../features/meetings/SpeakerBar";
import { SummaryPanel } from "../features/meetings/SummaryPanel";
import { TranscriptPanel } from "../features/meetings/TranscriptPanel";
import { fmtDate, fmtTime } from "../lib/format";

const TABS = [
  { id: "overview", label: "개요" },
  { id: "transcript", label: "회의록" },
  { id: "intelligence", label: "인사이트" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function MeetingPage() {
  const meetingId = Number(useParams().meetingId);
  const { data, isPending, isError, error } = useMeeting(meetingId);
  const [params, setParams] = useSearchParams();
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
  const review = meeting.status === "REVIEW_REQUIRED";
  const approved = meeting.status === "COMPLETED";
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
              editable={review}
              mySpeakerId={data.my_speaker_id}
            />
            <p className="mt-1.5 text-xs text-fg-subtle">
              {review
                ? "화자 이름은 승인 전까지만 바꿀 수 있습니다. [나로 지정]은 승인 후에도 바꿀 수 있습니다."
                : "[나로 지정]을 해 두면 채팅에서 “내가 요청한 것”을 물어볼 수 있습니다."}
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
          <Overview detail={data} approved={approved} onReview={() => setParams({ tab: "transcript" })} />
        ) : null}
        {tab === "transcript" ? (
          <TranscriptPanel key={`${meetingId}:${meeting.status}`} detail={data} />
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
  return (
    <div className="space-y-4">
      <Panel title="회의 정보">
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <HeldAtField key={m.held_at ?? ""} meetingId={m.id} heldAt={m.held_at} />
          <CategoryField meetingId={m.id} categoryId={m.category_id} />
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
        <SummaryPanel meetingId={m.id} approved={approved} />
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

      <DangerZone meeting={m} />
    </div>
  );
}
