import { Filter } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import {
  useAsk, useChatSession, useChatSessions, useCreateChatSession, useDeleteChatSession,
} from "../api/queries";
import type { ChatSessionDetail } from "../api/types";
import { Button } from "../components/ui/Button";
import { ErrorState, Spinner } from "../components/ui/feedback";
import { Composer } from "../features/chat/Composer";
import { Conversation } from "../features/chat/Conversation";
import { ScopeDialog } from "../features/chat/ScopeDialog";
import { SessionSidebar } from "../features/chat/SessionSidebar";

export function ChatPage() {
  const navigate = useNavigate();
  const routeId = useParams().sessionId;
  const sessionId = routeId ? Number(routeId) : null;
  const [params] = useSearchParams();

  const sessions = useChatSessions();
  const detail = useChatSession(sessionId);
  const create = useCreateChatSession();
  const remove = useDeleteChatSession();

  const bootstrapped = useRef(false);

  const goto = (id: number) => navigate(`/chat/${id}`, { replace: true });

  // `/chat` with no id: open the most recent conversation, or start one.
  // `?meeting_id=` is the old deep link from a meeting page and still works.
  useEffect(() => {
    if (sessionId !== null || !sessions.data || bootstrapped.current) return;
    bootstrapped.current = true;
    const preset = params.get("meeting_id");
    if (preset) create.mutate([Number(preset)], { onSuccess: (s) => goto(s.id) });
    else if (sessions.data.length > 0) goto(sessions.data[0]!.id);
    else create.mutate([], { onSuccess: (s) => goto(s.id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessions.data]);

  const scope = detail.data?.session.scope_meeting_ids ?? [];

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row">
      <SessionSidebar
        sessions={sessions.data ?? []}
        activeId={sessionId}
        loading={sessions.isPending}
        creating={create.isPending}
        deleting={remove.isPending}
        onNew={() => create.mutate([], { onSuccess: (s) => goto(s.id) })}
        onOpen={goto}
        onDelete={(id) =>
          remove.mutate(id, {
            onSuccess: () => {
              if (id === sessionId) {
                bootstrapped.current = false;
                navigate("/chat", { replace: true });
              }
            },
          })
        }
      />

      {sessionId === null || detail.isPending ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-fg-muted">
          <Spinner /> 대화를 준비하는 중…
        </div>
      ) : detail.isError ? (
        <div className="flex-1 p-5">
          <ErrorState error={detail.error} />
        </div>
      ) : (
        /* Keyed on the session: switching conversations must not carry an
           in-flight question or a scope-miss prompt across to the next one. */
        <ChatBody key={sessionId} sessionId={sessionId} scope={scope} detail={detail.data} />
      )}
    </div>
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
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <span className="text-xs text-fg-muted">검색 범위</span>
        <strong className="text-sm font-medium text-fg">
          {scope.length ? `선택한 회의 ${scope.length}개` : "전체 회의"}
        </strong>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setScopeOpen(true)}
          icon={<Filter className="size-4" />}
        >
          범위 변경
        </Button>
      </div>

      <Conversation
        messages={detail.messages}
        pendingQuestion={pending}
        scopeMiss={miss !== null}
        retrying={ask.isPending}
        onGlobalRetry={() => miss && send(miss, true)}
      />

      <Composer
        disabled={ask.isPending}
        sending={ask.isPending}
        onSend={(q) => send(q, false)}
      />

      {scopeOpen ? (
        <ScopeDialog onClose={() => setScopeOpen(false)} sessionId={sessionId} scope={scope} />
      ) : null}
    </section>
  );
}
