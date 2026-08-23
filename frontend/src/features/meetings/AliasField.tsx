import { useState } from "react";
import { toast } from "sonner";

import { useSetMeetingAlias } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/controls";
import { InlineNote } from "../../components/ui/feedback";

/**
 * 내 표시 이름 — what this account calls the meeting, on its own screens only.
 *
 * Not a rename, and the field says so: the recording's own name is shown under
 * it and never changes, because `meetings.title` belongs to whoever uploaded the
 * audio. Clearing the box goes back to that title rather than storing a copy of
 * it, so the owner renaming the recording still reaches everybody who never
 * chose a name.
 *
 * A shared reader may set one. Arranging your own list is not editing somebody's
 * minutes — the server writes `user_meeting_filing` and refuses every canonical
 * field either way.
 */
export function AliasField({
  meetingId, alias, title,
}: { meetingId: number; alias: string | null; title: string }) {
  const save = useSetMeetingAlias(meetingId);
  const [value, setValue] = useState(alias ?? "");
  const next = value.trim() || null;
  const dirty = next !== alias;

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) return;
        save.mutate(next, {
          onSuccess: () => toast.success(next ? "표시 이름을 바꿨습니다." : "원래 이름으로 되돌렸습니다."),
          onError: (err) => toast.error("저장 실패", { description: err.message }),
        });
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">내 표시 이름</span>
        <span className="flex items-center gap-1.5">
          <Input
            value={value}
            maxLength={200}
            placeholder={title}
            aria-label="내 표시 이름"
            onChange={(e) => setValue(e.target.value)}
            className="w-56"
          />
          {/* The 회의 정보 panel above has its own 저장; naming this one keeps the
              two distinguishable to anything that cannot see the layout. */}
          <Button
            size="sm"
            type="submit"
            aria-label="표시 이름 저장"
            disabled={!dirty}
            loading={save.isPending}
          >
            저장
          </Button>
        </span>
      </label>
      <InlineNote>
        내 화면에서만 쓰입니다. 원래 이름: {title}
      </InlineNote>
    </form>
  );
}
