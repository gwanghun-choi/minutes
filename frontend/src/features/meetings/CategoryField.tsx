import { toast } from "sonner";

import { useCategories, useSetMeetingCategory } from "../../api/queries";
import { Select } from "../../components/ui/controls";
import { InlineNote } from "../../components/ui/feedback";

/**
 * Which of *my* categories this meeting is in.
 *
 * Personal, not canonical (migration 011): a shared reader files their copy here
 * and the owner's screen does not move. That is why there is no ownership check
 * around it — the endpoint writes `user_meeting_filing`, keyed on (account,
 * meeting), and never the meeting.
 *
 * A native `<select>` is right here and wrong in the chat scope dialog: this is
 * one choice out of a handful, not a search through a growing list. Saving on
 * change with no separate button — a wrong pick is one more pick to undo, and
 * the value shown is whatever the server confirmed.
 *
 * A meeting is filed in exactly one category, including when that category has a
 * parent: the hierarchy is in the label, not in the assignment.
 */
export function CategoryField({
  meetingId, categoryId,
}: { meetingId: number; categoryId: number | null }) {
  const categories = useCategories();
  const save = useSetMeetingCategory(meetingId);

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-muted">카테고리</span>
      {/*
        Keyed on the option set, because a controlled <select> whose options
        arrive after it does keeps the wrong value. The tree is a second request:
        on the first render the only option is 미분류, the browser resets the
        node to "", and when the categories land React sees the same `value` it
        rendered before and writes nothing — so a meeting filed in 개발 showed
        미분류 until the page was reloaded. Remounting on the new option set is
        the whole fix.
      */}
      <Select
        key={(categories.data ?? []).length}
        className="w-56"
        value={categoryId === null ? "" : String(categoryId)}
        disabled={save.isPending || categories.isPending}
        onChange={(e) =>
          save.mutate(e.target.value ? Number(e.target.value) : null, {
            onError: (err) => toast.error("저장 실패", { description: err.message }),
          })
        }
      >
        <option value="">미분류</option>
        {/* The rendered path, so "개발" under 업무 and "개발" under 고객 are
            distinguishable in a plain select — the server already returns the
            tree in path order, so no grouping is needed here. */}
        {(categories.data ?? []).map((k) => (
          <option key={k.id} value={String(k.id)}>
            {k.path}
          </option>
        ))}
      </Select>
      {save.isPending ? <InlineNote>저장 중…</InlineNote> : null}
      {save.isError ? <InlineNote tone="error">저장하지 못했습니다.</InlineNote> : null}
    </label>
  );
}
