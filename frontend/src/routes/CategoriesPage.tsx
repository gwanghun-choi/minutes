import { ArrowLeft, FolderTree, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { useCategories, useCategoryMutations } from "../api/queries";
import type { MeetingCategory } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/Dialog";
import { Panel } from "../components/ui/Panel";
import { Input } from "../components/ui/controls";
import { EmptyState, ErrorState, SkeletonRows } from "../components/ui/feedback";

const NAME_MAX = 40;

/** Renaming happens in the row, so the count beside it stays visible. */
function Row({ category }: { category: MeetingCategory }) {
  const { rename, remove } = useCategoryMutations();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const name = draft?.trim() ?? "";

  const save = () => {
    if (!name || name === category.name) return setDraft(null);
    rename.mutate(
      { id: category.id, name },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success("이름을 바꿨습니다.");
        },
        onError: (err) => toast.error("이름 변경 실패", { description: err.message }),
      },
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 last:border-0">
      {draft === null ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {category.name}
          </span>
          <span className="shrink-0 text-xs whitespace-nowrap text-fg-muted">
            회의 {category.meeting_count}개
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${category.name} 이름 변경`}
            onClick={() => setDraft(category.name)}
            icon={<Pencil aria-hidden className="size-4" />}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${category.name} 삭제`}
            onClick={() => setConfirming(true)}
            icon={<Trash2 aria-hidden className="size-4" />}
          />
        </>
      ) : (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            value={draft}
            maxLength={NAME_MAX}
            aria-label={`${category.name} 이름`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            className="min-w-40 flex-1"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!name}
            loading={rename.isPending}
          >
            저장
          </Button>
          <Button size="sm" onClick={() => setDraft(null)}>
            취소
          </Button>
        </form>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="이 카테고리를 삭제할까요?"
        confirmLabel="삭제"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(category.id, {
            onSuccess: () => {
              setConfirming(false);
              toast.success("카테고리를 삭제했습니다.");
            },
            onError: (err) => toast.error("삭제 실패", { description: err.message }),
          })
        }
        body={
          <>
            <strong className="text-fg">{category.name}</strong> 라벨만 사라집니다. 이
            카테고리의 회의 {category.meeting_count}개는 삭제되지 않고 미분류로 이동합니다.
          </>
        }
      />
    </li>
  );
}

/**
 * Managing categories, away from the list that filters by them.
 *
 * Filtering is something an operator does constantly; renaming a label is
 * something they do a handful of times. Putting both in the meeting toolbar made
 * them look equally important, so management moved to its own route and the
 * toolbar keeps only a quiet link to it.
 */
export function CategoriesPage() {
  const categories = useCategories();
  const { create } = useCategoryMutations();
  const [draft, setDraft] = useState("");
  const rows = categories.data ?? [];

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    // No toast on failure: the message belongs beside the field that caused it,
    // and saying it twice is the same mistake as saying it nowhere.
    create.mutate(name, {
      onSuccess: () => {
        setDraft("");
        toast.success("카테고리를 추가했습니다.");
      },
    });
  };

  return (
    <>
      <PageHeader
        back={
          <Link to="/" aria-label="회의 목록으로" className="mt-1.5 text-fg-subtle hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
        }
        title="카테고리 관리"
        meta={
          <span>
            회의는 카테고리를 하나만 가집니다. 지정하지 않은 회의는 미분류로 남습니다.
          </span>
        }
      />

      <div className="mx-auto w-full max-w-3xl px-5 py-5">
        <Panel title="새 카테고리">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="예: 고객 미팅"
              aria-label="새 카테고리 이름"
              maxLength={NAME_MAX}
              className="min-w-52 flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              className="shrink-0"
              disabled={!draft.trim()}
              loading={create.isPending}
              icon={<Plus aria-hidden className="size-4" />}
            >
              추가
            </Button>
          </form>
          {create.isError ? (
            <div className="mt-2.5">
              <ErrorState error={create.error} />
            </div>
          ) : null}
        </Panel>

        <Panel
          title="카테고리"
          className="mt-4"
          bodyClassName=""
          actions={<span className="text-xs text-fg-muted">{rows.length}개</span>}
        >
          {categories.isPending ? (
            <SkeletonRows rows={3} className="p-4" />
          ) : categories.isError ? (
            <div className="p-4">
              <ErrorState error={categories.error} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<FolderTree className="size-6" />}
              title="아직 카테고리가 없습니다."
              hint="위에서 하나 만들면 회의 목록과 채팅 검색 범위에서 바로 고를 수 있습니다."
            />
          ) : (
            <ul>
              {rows.map((k) => (
                <Row key={k.id} category={k} />
              ))}
            </ul>
          )}
        </Panel>

        <p className="mt-3 text-xs text-fg-subtle">
          카테고리를 삭제해도 회의는 삭제되지 않습니다. 해당 회의는 미분류로 이동합니다.
        </p>
      </div>
    </>
  );
}
