import { Globe2, ListFilter } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { useAsk, useChatSession, useChatSessions, useCreateChatSession } from "../api/queries";
import type { ChatSessionDetail } from "../api/types";
import { Button } from "../components/ui/Button";
import { ErrorState, Spinner } from "../components/ui/feedback";
import { CANVAS } from "../features/chat/canvas";
import { Composer } from "../features/chat/Composer";
import { Conversation } from "../features/chat/Conversation";
import { ScopeDialog } from "../features/chat/ScopeDialog";

/**
 * One conversation. The list of them lives in the app sidebar, not here.
 */
export function ChatPage() {
  const navigate = useNavigate();
  const routeId = useParams().sessionId;
  const sessionId = routeId ? Number(routeId) : null;
  const [params] = useSearchParams();

  const sessions = useChatSessions();
  const detail = useChatSession(sessionId);
  const create = useCreateChatSession();

  // One bootstrap per visit to a bare `/chat`. Cleared as soon as a session is
  // open, so deleting the open conversation lands back here and resolves again.
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (sessionId !== null) {
      bootstrapped.current = false;
      return;
    }
    if (!sessions.data || bootstrapped.current) return;
    bootstrapped.current = true;
    const goto = (id: number) => navigate(`/chat/${id}`, { replace: true });
    // `?meeting_id=` is the deep link from a meeting page: it opens a new chat
    // already scoped to that meeting.
    const preset = params.get("meeting_id");
    if (preset) create.mutate([Number(preset)], { onSuccess: (s) => goto(s.id) });
    else if (sessions.data.length > 0) goto(sessions.data[0]!.id);
    else create.mutate([], { onSuccess: (s) => goto(s.id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessions.data]);

  if (sessionId === null || detail.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-fg-muted">
        <Spinner /> 대화를 준비하는 중…
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="flex-1 p-5">
        <ErrorState error={detail.error} />
      </div>
    );
  }
  /* Keyed on the session: switching conversations must not carry an in-flight
     question or a scope-miss prompt across to the next one. */
  return (
    <ChatBody
      key={sessionId}
      sessionId={sessionId}
      scope={detail.data.session.scope_meeting_ids}
      detail={detail.data}
    />
  );
}

function ChatBody({
  sessionId, scope, detail,
}: {
  sessionId: number;
  scope: number[];
  detail: ChatSessionDetail;
}) {
  const ask = useAsk(sessionId);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [miss, setMiss] = useState<string | null>(null);

  const send = (question: string, globalOverride: boolean) => {
    setMiss(null);
    setPending(question);
    ask.mutate(
      { question, global_override: globalOverride },
      {
        onSuccess: (res) => setMiss(res.scope_miss ? question : null),
        onError: (err) => toast.error("검색 실패", { description: err.message }),
        onSettled: () => setPending(null),
      },
    );
  };

  return (
    <section className="flex flex-1 flex-col md:h-dvh">
      {/* Full-width rule, content on the conversation's axis. */}
      <div className="border-b border-border bg-surface py-2">
        <div className={`${CANVAS} flex flex-wrap items-center gap-x-2 gap-y-1`}>
          <Globe2 aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
          <span className="text-xs text-fg-muted">검색 범위</span>
          <strong aria-label="현재 검색 범위" className="text-[13px] font-medium text-fg">
            {scope.length ? `선택한 회의 ${scope.length}개` : "전체 회의"}
          </strong>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setScopeOpen(true)}
            icon={<ListFilter aria-hidden className="size-4" />}
          >
            범위 변경
          </Button>
        </div>
      </div>

      <Conversation
        messages={detail.messages}
        pendingQuestion={pending}
        scopeMiss={miss !== null}
        retrying={ask.isPending}
        onGlobalRetry={() => miss && send(miss, true)}
      />

      <Composer disabled={ask.isPending} sending={ask.isPending} onSend={(q) => send(q, false)} />

      {scopeOpen ? (
        <ScopeDialog onClose={() => setScopeOpen(false)} sessionId={sessionId} scope={scope} />
      ) : null}
    </section>
  );
}
