import { ArrowUp } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/Button";
import { CANVAS } from "./canvas";

/**
 * The question box, on the conversation's own centre axis.
 *
 * It never spans the window: a full-width input beside a 48rem reading column
 * makes the two look like different screens. Enter sends, Shift+Enter is a
 * newline, and an IME composition is never treated as a send.
 */
export function Composer({
  disabled, sending, onSend,
}: { disabled: boolean; sending: boolean; onSend: (question: string) => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const question = value.trim();
    if (!question || sending) return;
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
    onSend(question);
  };

  return (
    <div className="sticky bottom-0 bg-bg pb-4">
      {/* The conversation fades out under the box rather than being cut off by
          a hard rule across the whole window. */}
      <div className="pointer-events-none h-5 bg-gradient-to-b from-transparent to-bg" />
      <form
        className={CANVAS}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface px-2.5 py-2 focus-within:border-border-strong">
          <textarea
            ref={ref}
            value={value}
            disabled={disabled}
            rows={1}
            aria-label="질문"
            placeholder="예: 배포는 언제까지 하기로 했어?"
            className="max-h-40 min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none disabled:text-fg-muted"
            onChange={(e) => {
              setValue(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="size-8 shrink-0 rounded-lg px-0"
            loading={sending}
            disabled={disabled || !value.trim()}
            icon={<ArrowUp aria-hidden className="size-4" />}
            aria-label="질문 보내기"
          />
        </div>
      </form>
    </div>
  );
}
