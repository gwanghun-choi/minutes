import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useCategories, useCategoryMutations } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/controls";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorState, SkeletonRows } from "../../components/ui/feedback";

/**
 * Category management, where categories are used.
 *
 * Five labels do not need an administration screen — they need a dialog on the
 * screen that filters by them. Delete confirms inline rather than in a second
 * modal: there is nothing to warn about beyond one sentence, and stacking two
 * dialogs to say it would be worse than saying it here.
 */
export function CategoryDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const categories = useCategories();
  const { create, rename, remove } = useCategoryMutations();
  const [draft, setDraft] = useState("");
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [confirming, setConfirming] = useState<number | null>(null);

  const close = () => {
    setDraft("");
    setEdits({});
    setConfirming(null);
    onOpenChange(false);
  };

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    create.mutate(name, {
      onSuccess: () => setDraft(""),
      onError: (err) => toast.error("추가 실패", { description: err.message }),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title="카테고리 관리"
      description="회의는 카테고리를 하나만 가질 수 있습니다. 지정하지 않으면 미분류입니다."
      className="w-[min(30rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={close}>
            닫기
          </Button>
        </>
      }
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="새 카테고리 이름"
          aria-label="새 카테고리 이름"
          maxLength={40}
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          className="shrink-0"
          disabled={!draft.trim()}
          loading={create.isPending}
          icon={<Plus aria-hidden className="size-4" />}
        >
          추가
        </Button>
      </form>

      {create.isError ? <ErrorState error={create.error} /> : null}

      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {categories.isPending ? (
          <SkeletonRows rows={3} className="p-3" />
        ) : (categories.data ?? []).length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">
            아직 카테고리가 없습니다.
          </p>
        ) : (
          <ul>
            {(categories.data ?? []).map((k) => {
              const value = edits[k.id] ?? k.name;
              const dirty = value.trim() !== k.name && value.trim() !== "";
              return (
                <li key={k.id} className="border-b border-border px-3 py-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <Input
                      value={value}
                      aria-label={`${k.name} 이름`}
                      maxLength={40}
                      onChange={(e) => setEdits({ ...edits, [k.id]: e.target.value })}
                    />
                    <span className="shrink-0 text-xs whitespace-nowrap text-fg-muted">
                      회의 {k.meeting_count}
                    </span>
                    {dirty ? (
                      <Button
                        size="sm"
                        variant="primary"
                        className="shrink-0"
                        loading={rename.isPending}
                        onClick={() =>
                          rename.mutate(
                            { id: k.id, name: value.trim() },
                            {
                              onSuccess: () => {
                                setEdits((prev) => {
                                  const next = { ...prev };
                                  delete next[k.id];
                                  return next;
                                });
                                toast.success("이름을 바꿨습니다.");
                              },
                              onError: (err) =>
                                toast.error("이름 변경 실패", { description: err.message }),
                            },
                          )
                        }
                      >
                        저장
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      aria-label={`${k.name} 삭제`}
                      onClick={() => setConfirming(confirming === k.id ? null : k.id)}
                      icon={<Trash2 aria-hidden className="size-4" />}
                    />
                  </div>

                  {confirming === k.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-muted px-2.5 py-2">
                      <p className="min-w-0 flex-1 text-xs text-fg-muted">
                        이 카테고리의 회의 {k.meeting_count}개는 삭제되지 않고 미분류로
                        이동합니다.
                      </p>
                      <Button size="sm" onClick={() => setConfirming(null)}>
                        취소
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={remove.isPending}
                        onClick={() =>
                          remove.mutate(k.id, {
                            onSuccess: () => {
                              setConfirming(null);
                              toast.success("카테고리를 삭제했습니다.");
                            },
                            onError: (err) =>
                              toast.error("삭제 실패", { description: err.message }),
                          })
                        }
                      >
                        삭제
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
