import { SendHorizonal } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/Button";

/** Enter sends, Shift+Enter is a newline. The box grows with the question. */
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
    <form
      className="flex items-end gap-2 border-t border-border bg-surface px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        rows={1}
        aria-label="질문"
        placeholder="예: 배포는 언제까지 하기로 했어?"
        className="max-h-40 min-h-9 flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle disabled:bg-surface-muted"
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
        loading={sending}
        disabled={disabled || !value.trim()}
        icon={<SendHorizonal className="size-4" />}
        aria-label="질문 보내기"
      />
    </form>
  );
}
