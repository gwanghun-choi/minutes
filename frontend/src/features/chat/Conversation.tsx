import { Globe2, Info, MessagesSquare } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { ChatMessage, RagSource } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { EmptyState, Spinner } from "../../components/ui/feedback";
import { isNoticeAnswer } from "../../lib/labels";
import { CANVAS } from "./canvas";
import { Citation, SourceTrigger } from "./SourceDrawer";

/** What the 출처 drawer is showing: one answer's cited evidence, and which card
 *  to focus. */
export interface Shown {
  sources: RagSource[];
  index: number | null;
}

/**
 * Content first, decoration second.
 *
 * A question and an answer are different kinds of thing and must be tellable
 * apart without reading them — but only one of them needs a container. A
 * question is a short thing somebody typed, so it is a compact right-aligned
 * bubble that ends where the text does. An answer is the page's content: it is
 * left-aligned prose on the page itself, with no card, no border and no
 * background, so a two-line reply looks like two lines rather than a two-line
 * sentence inside a full-width panel.
 *
 * What separates the two is alignment and colour, which cost nothing vertically.
 * A notice — guidance about the search rather than a finding from a meeting —
 * keeps its tinted box, because that difference is the whole point of it.
 *
 * The evidence is not in this column: it opens in the 출처 drawer beside the
 * conversation. What is in the answer is the citation markers the model wrote,
 * each one a way into that drawer.
 */
const Question = ({ text }: { text: string }) => (
  <div className="flex justify-end">
    <p className="max-w-[80%] rounded-2xl rounded-br-md bg-surface-sunken px-3.5 py-2 text-[15px] whitespace-pre-wrap text-fg">
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
 * the model wrote it, inside the same `whitespace-pre-wrap` block. A number that
 * names no card on screen is left as plain text — `rag.validate_citations`
 * already removes citations to evidence that was never sent, and inventing a
 * link to a card that is not there would undo that.
 *
 * The numbers are the ones retrieval assigned, so they are not necessarily
 * 1..N: an answer citing the third and seventh excerpts says `[3]` and `[7]`,
 * and the panel labels those two cards `[3]` and `[7]`.
 */
function AnswerText({
  content, shown, onCite,
}: { content: string; shown: Set<number>; onCite: (index: number) => void }) {
  return (
    <div className="text-[15px] leading-[1.75] whitespace-pre-wrap text-fg">
      {content.split(/(\[\d+\])/g).map((part, i) => {
        const n = Number(/^\[(\d+)\]$/.exec(part)?.[1]);
        return shown.has(n) ? (
          <Citation key={i} n={n} onSelect={onCite} />
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </div>
  );
}

function Answer({
  message, openSources, onToggle, onCite,
}: {
  message: ChatMessage;
  /** The source list currently in the drawer, so this answer can show it open. */
  openSources: RagSource[] | null;
  onToggle: (shown: Shown) => void;
  onCite: (shown: Shown) => void;
}) {
  /* 출처 is what this answer cited, and the server decides that: it reads the
     `[N]` markers out of the stored answer and hands back exactly those rows.
     The retrieved candidates behind them are still in `message.sources` and in
     the database — they are the provenance of the *search*, and mixing them into
     the panel put unquoted results beside quoted evidence. */
  const sources = message.cited_sources ?? [];
  const shown = new Set(sources.map((s) => s.index));

  if (isNoticeAnswer(message.content)) {
    return (
      <Notice>
        <p className="whitespace-pre-wrap">{message.content}</p>
      </Notice>
    );
  }
  return (
    <div className="min-w-0">
      <AnswerText
        content={message.content}
        shown={shown}
        onCite={(index) => onCite({ sources, index })}
      />
      <SourceTrigger
        sources={sources}
        open={openSources === sources}
        onToggle={() => onToggle({ sources, index: null })}
      />
    </div>
  );
}

export function Conversation({
  messages, pendingQuestion, scopeMiss, onGlobalRetry, retrying,
  openSources, onToggleSources, onCite,
}: {
  messages: ChatMessage[];
  pendingQuestion: string | null;
  scopeMiss: boolean;
  onGlobalRetry: () => void;
  retrying: boolean;
  openSources: RagSource[] | null;
  /** The 출처 button: open this answer's evidence, or close it if it is already
   *  the one showing. */
  onToggleSources: (shown: Shown) => void;
  /** A `[N]` inside the answer: open the drawer on that source. */
  onCite: (shown: Shown) => void;
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
          hint="답변에는 인용한 회의록 원문이 출처로 함께 붙습니다. 특정 회의만 보려면 위에서 검색 범위를 좁히세요."
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-6">
      {/* A question sits close to the answer it produced and further from the
          exchange before it, so the column reads in pairs rather than as an
          evenly spaced list. */}
      <div className={`${CANVAS} flex flex-col gap-3`}>
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className={i === 0 ? "" : "mt-6"}>
              <Question text={m.content} />
            </div>
          ) : (
            <Answer
              key={i}
              message={m}
              openSources={openSources}
              onToggle={onToggleSources}
              onCite={onCite}
            />
          ),
        )}

        {pendingQuestion ? (
          <>
            <div className={messages.length ? "mt-6" : ""}>
              <Question text={pendingQuestion} />
            </div>
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
