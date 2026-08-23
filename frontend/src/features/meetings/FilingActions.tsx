import { FolderInput, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useCategories, useSetMeetingAlias, useSetMeetingCategory } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Menu, MenuItem } from "../../components/ui/Menu";
import { Field, Input, Select } from "../../components/ui/controls";

/**
 * Filing a meeting from wherever it is listed, instead of from inside it.
 *
 * Renaming a meeting on my own screen and moving it into one of my folders are
 * everyday acts on a *list*, and they used to require opening the meeting to
 * reach the 내 정리 panel. Both write `user_meeting_filing` through the hooks
 * that panel already uses — one endpoint, one cache invalidation, two places to
 * reach it.
 *
 * Both are open to a shared reader, and that is the whole point of migration
 * 011: an alias is a lens over somebody else's meeting and a category is my
 * folder, so neither touches `meetings` and the owner's screen does not move.
 * Deleting is the exception and stays the owner's — the server refuses it from
 * anybody else either way.
 */
export interface Filed {
  id: number;
  /** The recording's own name. What clearing the alias goes back to. */
  title: string;
  /** `alias ?? title` — what this account sees. */
  display_title: string;
  alias: string | null;
  category_id: number | null;
}

export type FilingAction =
  | { mode: "rename"; meeting: Filed }
  | { mode: "move"; meeting: Filed };

/** The `⋯` on a meeting row. `onDelete` is omitted for a meeting I do not own. */
export function MeetingRowMenu({
  meeting, onAct, onDelete,
}: {
  meeting: Filed;
  onAct: (action: FilingAction) => void;
  onDelete?: () => void;
}) {
  return (
    <Menu label={`${meeting.display_title} 관리 메뉴`}>
      <MenuItem
        onSelect={() => onAct({ mode: "rename", meeting })}
        icon={<Pencil aria-hidden className="size-3.5" />}
      >
        이름 변경
      </MenuItem>
      <MenuItem
        onSelect={() => onAct({ mode: "move", meeting })}
        icon={<FolderInput aria-hidden className="size-3.5" />}
      >
        카테고리 이동
      </MenuItem>
      {onDelete ? (
        <>
          <div className="my-1 h-px bg-border" />
          <MenuItem
            destructive
            onSelect={onDelete}
            icon={<Trash2 aria-hidden className="size-3.5" />}
          >
            삭제
          </MenuItem>
        </>
      ) : null}
    </Menu>
  );
}

/**
 * 내 표시 이름, in a dialog.
 *
 * Not a rename of the meeting, and the field says so: the recording's own name
 * sits under the box and never changes. Clearing the box goes back to that name
 * rather than storing a copy of it, so the owner renaming the recording still
 * reaches everybody who never chose a name of their own.
 */
function RenameDialog({ meeting, onClose }: { meeting: Filed; onClose: () => void }) {
  const save = useSetMeetingAlias(meeting.id);
  const [value, setValue] = useState(meeting.alias ?? "");
  const next = value.trim() || null;

  const submit = () => {
    if (next === meeting.alias) return onClose();
    save.mutate(next, {
      onSuccess: () => {
        toast.success(next ? "표시 이름을 바꿨습니다." : "원래 이름으로 되돌렸습니다.");
        onClose();
      },
      onError: (err) => toast.error("저장 실패", { description: err.message }),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="이름 변경"
      description="내 화면에서만 쓰이는 이름입니다. 다른 사용자에게는 보이지 않습니다."
      className="w-[min(26rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={submit}>
            저장
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="내 표시 이름"
          hint={`비워 두면 원래 이름으로 돌아갑니다. 원래 이름: ${meeting.title}`}
        >
          <Input
            autoFocus
            value={value}
            maxLength={200}
            placeholder={meeting.title}
            aria-label="내 표시 이름"
            onChange={(e) => setValue(e.target.value)}
            className="h-9 w-full"
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** Which of *my* folders this meeting sits in. One folder, or none. */
function MoveDialog({ meeting, onClose }: { meeting: Filed; onClose: () => void }) {
  const categories = useCategories();
  const save = useSetMeetingCategory(meeting.id);
  const [value, setValue] = useState(
    meeting.category_id === null ? "" : String(meeting.category_id),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="카테고리 이동"
      description="카테고리는 내 화면에서만 쓰이며 다른 사용자에게 보이지 않습니다."
      className="w-[min(26rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>취소</Button>
          <Button
            size="sm"
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate(value ? Number(value) : null, {
                onSuccess: () => {
                  toast.success("카테고리를 옮겼습니다.");
                  onClose();
                },
                onError: (err) => toast.error("저장 실패", { description: err.message }),
              })
            }
          >
            이동
          </Button>
        </>
      }
    >
      <Field label="카테고리">
        {/* Keyed on the option set — see `CategoryField` for why a controlled
            select whose options arrive later keeps the wrong value. */}
        <Select
          key={(categories.data ?? []).length}
          value={value}
          disabled={categories.isPending}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 w-full"
        >
          <option value="">미분류</option>
          {/* The rendered path, so "개발" under 업무 and "개발" under 고객 are
              distinguishable — the server returns the tree in path order. */}
          {(categories.data ?? []).map((k) => (
            <option key={k.id} value={String(k.id)}>{k.path}</option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}

/** Whichever of the two the row menu asked for. Mounted once per list. */
export function FilingDialog({
  action, onClose,
}: { action: FilingAction | null; onClose: () => void }) {
  if (!action) return null;
  return action.mode === "rename" ? (
    <RenameDialog meeting={action.meeting} onClose={onClose} />
  ) : (
    <MoveDialog meeting={action.meeting} onClose={onClose} />
  );
}
