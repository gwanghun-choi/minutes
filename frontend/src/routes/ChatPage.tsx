import { Globe2, ListFilter } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { useAsk, useChatSession, useChatSessions, useCreateChatSession } from "../api/queries";
import type { ChatSessionDetail } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { ErrorState, Spinner } from "../components/ui/feedback";
import { Composer } from "../features/chat/Composer";
import { Conversation, type Shown } from "../features/chat/Conversation";
import { ScopeDialog } from "../features/chat/ScopeDialog";
import { SourceDrawer } from "../features/chat/SourceDrawer";

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
  /* Which answer's 출처 the drawer is showing, and which citation was clicked to
     open it. Held here because the drawer is a sibling of the whole conversation
     rather than of one message — and kept after closing, so the panel can slide
     out with its contents still in it instead of emptying mid-animation. */
  const [shown, setShown] = useState<Shown | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  /** The 출처 button is a toggle: the same answer's button closes what it opened.
   *  A different answer's replaces the contents and keeps the drawer open. */
  const toggle = (next: Shown) => {
    if (drawerOpen && shown?.sources === next.sources && next.index === null) {
      setDrawerOpen(false);
      return;
    }
    setShown(next);
    setDrawerOpen(true);
  };

  const send = (question: string, globalOverride: boolean) => {
    setMiss(null);
    setPending(question);
    setDrawerOpen(false);
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
    <>
      {/* The conversation's name is the page's title, so a rename in the sidebar
          shows up here too — both read the same refetched session. The scope is
          what makes this page different from every other one, so it sits where
          a page's own actions sit. */}
      <PageHeader
        title={detail.session.title}
        meta={
          <span className="flex items-center gap-1.5">
            <Globe2 aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
            <span aria-label="현재 검색 범위" className="whitespace-nowrap">
              {scope.length ? `선택한 회의 ${scope.length}개` : "접근 가능한 전체 회의"}
            </span>
          </span>
        }
        actions={
          <Button
            size="sm"
            onClick={() => setScopeOpen(true)}
            icon={<ListFilter aria-hidden className="size-4" />}
          >
            범위 변경
          </Button>
        }
      />

      {/* `relative` so the 출처 drawer can sit inside this region rather than
          over the whole window — see `SourceDrawer`. */}
      <section className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <Conversation
            messages={detail.messages}
            pendingQuestion={pending}
            scopeMiss={miss !== null}
            retrying={ask.isPending}
            onGlobalRetry={() => miss && send(miss, true)}
            openSources={drawerOpen ? shown?.sources ?? null : null}
            onToggleSources={toggle}
            onCite={toggle}
          />

          <Composer disabled={ask.isPending} sending={ask.isPending} onSend={(q) => send(q, false)} />
        </div>

        {/* The evidence drawer, over the conversation rather than inside it. It
            holds exactly what the answer cited — the same list the 출처 count
            describes. Always mounted so it can slide rather than appear. */}
        <SourceDrawer
          sources={shown?.sources ?? []}
          selected={shown?.index ?? null}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />
      </section>

      {scopeOpen ? (
        <ScopeDialog onClose={() => setScopeOpen(false)} sessionId={sessionId} scope={scope} />
      ) : null}
    </>
  );
}
