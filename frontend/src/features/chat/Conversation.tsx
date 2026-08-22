import { Globe2, Info, MessagesSquare } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { ChatMessage, RagSource } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { EmptyState, Spinner } from "../../components/ui/feedback";
import { isNoticeAnswer } from "../../lib/labels";
import { CANVAS } from "./canvas";
import { Citation, SourceTrigger } from "./SourceDrawer";

/**
 * Four blocks, four shapes.
 *
 * A question, an answer, the evidence behind it, and a notice about the search
 * itself are different kinds of thing, so none of them may be told apart only by
 * reading it. A question is a right-aligned tinted bubble; an answer is a
 * left-aligned surface that ends where its 출처 control does, so a long
 * conversation reads as question / answer / question / answer at a glance. A
 * notice is a tinted box.
 *
 * The evidence itself is not in this column any more — it opens in the 출처
 * panel beside the conversation. What is in the answer is the citation markers
 * the model wrote, each one a way into that panel.
 */
const Question = ({ text }: { text: string }) => (
  <div className="mt-4 flex justify-end first:mt-0">
    <p className="max-w-[85%] rounded-2xl rounded-br-md border border-primary/15 bg-primary-soft px-3.5 py-2 text-sm whitespace-pre-wrap text-fg">
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

/**
 * The answer text with its `[N]` markers turned into buttons.
 *
 * Split rather than rewritten: every other character reaches the DOM exactly as
 * the model wrote it, inside the same `whitespace-pre-wrap` block. A number
 * outside the retrieved range is left as plain text — `rag.validate_citations`
 * already removes citations to evidence that was never sent, and inventing a
 * link here would undo that.
 */
function AnswerText({
  content, count, onCite,
}: { content: string; count: number; onCite: (index: number) => void }) {
  return (
    <div className="text-[15px] leading-[1.75] whitespace-pre-wrap text-fg">
      {content.split(/(\[\d+\])/g).map((part, i) => {
        const n = Number(/^\[(\d+)\]$/.exec(part)?.[1]);
        return n >= 1 && n <= count ? (
          <Citation key={i} n={n} onSelect={onCite} />
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </div>
  );
}

function Answer({
  message, openSources, onOpen,
}: {
  message: ChatMessage;
  /** The source list currently in the panel, so this answer can show it open. */
  openSources: RagSource[] | null;
  onOpen: (sources: RagSource[], index: number | null) => void;
}) {
  const sources = message.sources ?? [];
  if (isNoticeAnswer(message.content)) {
    return (
      <Notice>
        <p className="whitespace-pre-wrap">{message.content}</p>
      </Notice>
    );
  }
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-panel">
      <AnswerText
        content={message.content}
        count={sources.length}
        onCite={(index) => onOpen(sources, index)}
      />
      <SourceTrigger
        count={sources.length}
        open={openSources === sources}
        onOpen={() => onOpen(sources, null)}
      />
    </div>
  );
}

export function Conversation({
  messages, pendingQuestion, scopeMiss, onGlobalRetry, retrying, openSources, onOpenSources,
}: {
  messages: ChatMessage[];
  pendingQuestion: string | null;
  scopeMiss: boolean;
  onGlobalRetry: () => void;
  retrying: boolean;
  openSources: RagSource[] | null;
  onOpenSources: (sources: RagSource[], index: number | null) => void;
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
          hint="답변에는 항상 출처가 되는 회의록 원문이 함께 붙습니다. 특정 회의만 보려면 위에서 검색 범위를 좁히세요."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-6">
      <div className={`${CANVAS} flex flex-col gap-4`}>
        {messages.map((m, i) =>
          m.role === "user" ? (
            <Question key={i} text={m.content} />
          ) : (
            <Answer key={i} message={m} openSources={openSources} onOpen={onOpenSources} />
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
