import { ArrowLeft, CornerDownRight, FolderTree, Move, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { useCategories, useCategoryMutations } from "../api/queries";
import type { MeetingCategory } from "../api/types";
import { PageHeader } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/Dialog";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Panel } from "../components/ui/Panel";
import { Input, Select } from "../components/ui/controls";
import { EmptyState, ErrorState, SkeletonRows } from "../components/ui/feedback";

const NAME_MAX = 40;

/**
 * A category and everything under it, computed from the flat list.
 *
 * Only for deciding which parents to *offer*: moving a category under its own
 * descendant is refused by the server (`categories._would_cycle`), and this
 * keeps the UI from proposing it in the first place.
 */
function subtree(rows: MeetingCategory[], id: number): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parent_id !== null && out.has(row.parent_id) && !out.has(row.id)) {
        out.add(row.id);
        grew = true;
      }
    }
  }
  return out;
}

/** The parent options for a category: the root, plus anything outside its own
 *  subtree. `null` id means 최상위. */
function parentOptions(rows: MeetingCategory[], id: number | null): MeetingCategory[] {
  const blocked = id === null ? new Set<number>() : subtree(rows, id);
  return rows.filter((r) => !blocked.has(r.id));
}

/** Renaming and moving both happen in the row, so the counts stay visible. */
function Row({ category, rows }: { category: MeetingCategory; rows: MeetingCategory[] }) {
  const { rename, move, remove } = useCategoryMutations();
  const [mode, setMode] = useState<"idle" | "rename" | "move">("idle");
  const [draft, setDraft] = useState(category.name);
  const [confirming, setConfirming] = useState(false);
  const name = draft.trim();
  const blocked = category.child_count > 0;

  const save = () => {
    if (!name || name === category.name) return setMode("idle");
    rename.mutate(
      { id: category.id, name },
      {
        onSuccess: () => {
          setMode("idle");
          toast.success("이름을 바꿨습니다.");
        },
        onError: (err) => toast.error("이름 변경 실패", { description: err.message }),
      },
    );
  };

  return (
    <li className="border-b border-border last:border-0">
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2.5"
        style={{ paddingLeft: `${category.depth * 1.25 + 1}rem` }}
      >
        {mode === "rename" ? (
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
              onKeyDown={(e) => e.key === "Escape" && setMode("idle")}
              className="min-w-40 flex-1"
            />
            <Button type="submit" size="sm" variant="primary" disabled={!name} loading={rename.isPending}>
              저장
            </Button>
            <Button size="sm" onClick={() => setMode("idle")}>
              취소
            </Button>
          </form>
        ) : mode === "move" ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{category.name}</span>
            <Select
              autoFocus
              aria-label={`${category.name} 상위 카테고리`}
              className="w-52"
              value={category.parent_id === null ? "" : String(category.parent_id)}
              disabled={move.isPending}
              onChange={(e) =>
                move.mutate(
                  { id: category.id, parent_id: e.target.value ? Number(e.target.value) : null },
                  {
                    onSuccess: () => {
                      setMode("idle");
                      toast.success("상위 카테고리를 바꿨습니다.");
                    },
                    onError: (err) => toast.error("이동 실패", { description: err.message }),
                  },
                )
              }
            >
              <option value="">최상위</option>
              {parentOptions(rows, category.id).map((k) => (
                <option key={k.id} value={String(k.id)}>
                  {k.path}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => setMode("idle")}>
              닫기
            </Button>
          </div>
        ) : (
          <>
            {category.depth > 0 ? (
              <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={category.path}>
              {category.name}
            </span>
            <span className="shrink-0 text-xs whitespace-nowrap text-fg-muted">
              회의 {category.meeting_count}개
            </span>
            {blocked ? (
              <span className="shrink-0 text-xs whitespace-nowrap text-fg-subtle">
                하위 {category.child_count}개
              </span>
            ) : null}
            <Menu label={`${category.name} 관리 메뉴`}>
              <MenuItem
                onSelect={() => {
                  setDraft(category.name);
                  setMode("rename");
                }}
                icon={<Pencil aria-hidden className="size-3.5" />}
              >
                이름 변경
              </MenuItem>
              <MenuItem
                onSelect={() => setMode("move")}
                icon={<Move aria-hidden className="size-3.5" />}
              >
                상위 변경
              </MenuItem>
              <MenuItem
                destructive
                onSelect={() => setConfirming(true)}
                icon={<Trash2 aria-hidden className="size-3.5" />}
              >
                삭제
              </MenuItem>
            </Menu>
          </>
        )}
      </div>

      {/* A parent is never deleted with its children: the dialog says so instead
          of the click failing with a 409 the user has to interpret. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={blocked ? "먼저 하위 카테고리를 정리해 주세요." : "이 카테고리를 삭제할까요?"}
        confirmLabel="삭제"
        destructive
        confirmDisabled={blocked}
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
          blocked ? (
            <>
              <strong className="text-fg">{category.name}</strong> 아래에 카테고리{" "}
              {category.child_count}개가 있습니다. 하위 카테고리를 다른 곳으로 옮기거나 먼저
              삭제한 뒤에 이 카테고리를 삭제할 수 있습니다.
            </>
          ) : (
            <>
              <strong className="text-fg">{category.name}</strong> 라벨만 사라집니다. 이
              카테고리의 회의 {category.meeting_count}개는 삭제되지 않고 미분류로 이동합니다.
            </>
          )
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
 *
 * The tree is rendered from the flat, path-ordered list the server returns —
 * depth is indentation, and nothing here recomputes the hierarchy.
 */
export function CategoriesPage() {
  const categories = useCategories();
  const { create } = useCategoryMutations();
  const [draft, setDraft] = useState("");
  const [parent, setParent] = useState("");
  const rows = categories.data ?? [];

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    // No toast on failure: the message belongs beside the field that caused it,
    // and saying it twice is the same mistake as saying it nowhere.
    create.mutate(
      { name, parent_id: parent ? Number(parent) : null },
      {
        onSuccess: () => {
          setDraft("");
          toast.success("카테고리를 추가했습니다.");
        },
      },
    );
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
            회의는 카테고리를 하나만 가집니다. 상위 카테고리를 고르면 그 아래 카테고리의 회의까지
            함께 조회됩니다.
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
            <Select
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              aria-label="상위 카테고리"
              className="w-44"
            >
              <option value="">최상위</option>
              {rows.map((k) => (
                <option key={k.id} value={String(k.id)}>
                  {k.path}
                </option>
              ))}
            </Select>
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
                <Row key={k.id} category={k} rows={rows} />
              ))}
            </ul>
          )}
        </Panel>

        <p className="mt-3 text-xs text-fg-subtle">
          카테고리를 삭제해도 회의는 삭제되지 않습니다. 해당 회의는 미분류로 이동합니다. 하위
          카테고리가 있는 카테고리는 하위를 먼저 정리해야 삭제할 수 있습니다.
        </p>
      </div>
    </>
  );
}
