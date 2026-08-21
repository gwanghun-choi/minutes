import { Globe2, MessagesSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ChatMessage } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { EmptyState, Spinner } from "../../components/ui/feedback";
import { CANVAS } from "./canvas";
import { SourceList } from "./SourceList";

/** A question, as a compact bubble. The answer needs no container. */
const Question = ({ text }: { text: string }) => (
  <p className="ml-auto max-w-[80%] rounded-md bg-surface-muted px-3 py-2 text-sm whitespace-pre-wrap text-fg">
    {text}
  </p>
);

export function Conversation({
  messages, pendingQuestion, scopeMiss, onGlobalRetry, retrying,
}: {
  messages: ChatMessage[];
  pendingQuestion: string | null;
  scopeMiss: boolean;
  onGlobalRetry: () => void;
  retrying: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pendingQuestion, scopeMiss]);

  if (messages.length === 0 && !pendingQuestion) {
    return (
      <div className="flex-1 overflow-y-auto">
        <EmptyState
          icon={<MessagesSquare className="size-6" />}
          title="회의록에 물어보세요."
          hint="답변에는 항상 근거가 되는 회의록 원문이 함께 붙습니다. 특정 회의만 보려면 위에서 검색 범위를 좁히세요."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-6">
      <div className={`${CANVAS} flex flex-col gap-6`}>
        {messages.map((m, i) =>
          m.role === "user" ? (
            <Question key={i} text={m.content} />
          ) : (
            /* No card around an answer: the text is the thing, and its
               evidence sits under it rather than in a stack of boxes. */
            <div key={i} className="min-w-0">
              <div className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
                {m.content}
              </div>
              <SourceList sources={m.sources ?? []} />
            </div>
          ),
        )}

        {pendingQuestion ? (
          <>
            <Question text={pendingQuestion} />
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner /> 회의록을 찾는 중…
            </p>
          </>
        ) : null}

        {/* The backend already answered inside the chosen scope and stopped
            there. Widening the search is a click, never something that happens
            quietly. */}
        {scopeMiss ? (
          <div className="rounded-md border border-warning/30 bg-warning-soft px-3.5 py-3">
            <p className="text-sm text-fg">선택한 회의에서는 해당 내용을 찾지 못했습니다.</p>
            <Button
              size="sm"
              className="mt-2"
              loading={retrying}
              onClick={onGlobalRetry}
              icon={<Globe2 className="size-4" />}
            >
              전체 회의에서 다시 검색
            </Button>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  );
}
