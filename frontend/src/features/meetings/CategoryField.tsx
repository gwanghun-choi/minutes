import { toast } from "sonner";

import { useCategories, useSetMeetingCategory } from "../../api/queries";
import { Select } from "../../components/ui/controls";
import { InlineNote } from "../../components/ui/feedback";

/**
 * Which category this meeting is in.
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
      <Select
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
