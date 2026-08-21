import { Globe2, Info, MessagesSquare } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { ChatMessage } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { EmptyState, Spinner } from "../../components/ui/feedback";
import { isNoticeAnswer } from "../../lib/labels";
import { CANVAS } from "./canvas";
import { SourceList } from "./SourceList";

/**
 * Four blocks, four shapes.
 *
 * A question, an answer, the evidence under it, and a notice about the search
 * itself are different kinds of thing, so none of them may be told apart only by
 * reading it. A question is a right-aligned bubble; an answer is plain prose on
 * the page, because wrapping it in a card would make it compete with its own
 * evidence; a notice is a tinted box.
 */
const Question = ({ text }: { text: string }) => (
  <div className="flex justify-end">
    <p className="max-w-[80%] rounded-2xl rounded-br-md bg-surface-muted px-3.5 py-2 text-sm whitespace-pre-wrap text-fg">
      {text}
    </p>
  </div>
);

/** Guidance about the search, not a finding from a meeting. */
const Notice = ({ children }: { children: ReactNode }) => (
  <div className="flex items-start gap-2.5 rounded-md border border-warning/25 bg-warning-soft px-3.5 py-3">
    <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
    <div className="min-w-0 flex-1 text-sm leading-relaxed text-fg">{children}</div>
  </div>
);

function Answer({ message }: { message: ChatMessage }) {
  if (isNoticeAnswer(message.content)) {
    return (
      <Notice>
        <p className="whitespace-pre-wrap">{message.content}</p>
      </Notice>
    );
  }
  return (
    <div className="min-w-0">
      <div className="text-[15px] leading-[1.75] whitespace-pre-wrap text-fg">
        {message.content}
      </div>
      <SourceList sources={message.sources ?? []} />
    </div>
  );
}

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
      <div className={`${CANVAS} flex flex-col gap-7`}>
        {messages.map((m, i) =>
          m.role === "user" ? <Question key={i} text={m.content} /> : <Answer key={i} message={m} />,
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
          <Notice>
            <p>선택한 회의에서는 해당 내용을 찾지 못했습니다.</p>
            <Button
              size="sm"
              className="mt-2"
              loading={retrying}
              onClick={onGlobalRetry}
              icon={<Globe2 className="size-4" />}
            >
              전체 회의에서 다시 검색
            </Button>
          </Notice>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  );
}
