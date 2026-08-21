import { useState } from "react";
import { toast } from "sonner";

import { useSetHeldAt } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/controls";
import { InlineNote } from "../../components/ui/feedback";
import { fromLocalInput, toLocalInput } from "../../lib/format";

/**
 * When the meeting actually took place.
 *
 * `created_at` is when the file was uploaded, and the two are the same only by
 * accident — cross-meeting ordering and relative deadlines read this field. A
 * native `datetime-local` covers it; no date library is involved.
 *
 * The caller keys this component on `heldAt`, so a value that changes on the
 * server remounts the field with it — and nothing overwrites what is being
 * typed in the meantime.
 */
export function HeldAtField({ meetingId, heldAt }: { meetingId: number; heldAt: string | null }) {
  const [value, setValue] = useState(() => toLocalInput(heldAt));
  const save = useSetHeldAt(meetingId);
  const dirty = value !== toLocalInput(heldAt);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">회의 일시</span>
        <Input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-56"
        />
      </label>
      <Button
        size="sm"
        variant={dirty ? "primary" : "secondary"}
        disabled={!dirty}
        loading={save.isPending}
        onClick={() =>
          save.mutate(fromLocalInput(value), {
            onSuccess: () =>
              toast.success(
                value ? "회의 일시를 저장했습니다." : "회의 일시를 지웠습니다.",
                {
                  description: value
                    ? "이미 추출된 기한은 [인사이트 다시 생성] 후에 다시 계산됩니다."
                    : "목록 정렬은 등록일로 대체됩니다.",
                },
              ),
            onError: (err) => toast.error("저장 실패", { description: err.message }),
          })
        }
      >
        저장
      </Button>
      {!heldAt ? (
        <InlineNote>미설정 — 실제 개최일이 아직 입력되지 않았습니다.</InlineNote>
      ) : null}
    </div>
  );
}
