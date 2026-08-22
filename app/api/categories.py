"""Meeting categories: a tree of labels, one per meeting at most.

`meetings.category_id` is a nullable FK with ON DELETE SET NULL, so NULL is 미분류
and deleting a category never deletes a meeting. `meeting_categories.parent_id` is
a nullable self-reference with ON DELETE RESTRICT, so a parent with children
cannot be removed. PostgreSQL carries both rules, not this module.

A meeting is still filed in exactly one category. The tree changes what a *query*
means, never what an assignment means: picking a parent searches that parent and
everything under it, through `SUBTREE`.

No roles and no ownership: every logged-in user sees and edits the same tree,
exactly like meetings.
"""
from fastapi import APIRouter, HTTPException
from psycopg.errors import ForeignKeyViolation, UniqueViolation
from pydantic import BaseModel

from app.db import conn

router = APIRouter(prefix="/api/meeting-categories", tags=["categories"])

NAME_MAX = 40

# "This category and everything under it", as one piece of SQL.
#
# The meeting list's category filter and the cycle check both use it, so
# "descendant" cannot come to mean two different things — the same rule the
# retrieval layer follows for its scope predicate. `%(cat)s` is the root id.
SUBTREE = """
    WITH RECURSIVE sub AS (
        SELECT id FROM meeting_categories WHERE id = %(cat)s
        UNION ALL
        SELECT k.id FROM meeting_categories k JOIN sub ON k.parent_id = sub.id
    )
    SELECT id FROM sub
"""

# The whole tree, pre-ordered, with the rendered path every screen shows.
#
# Depth and path are the database's job: computing them in the browser would mean
# every screen that shows "업무 / 개발" agreeing on how to build it. Ordering by
# path is what makes a flat list render as a tree without a second sort.
TREE = """
    WITH RECURSIVE tree AS (
        SELECT k.id, k.name, k.parent_id, k.name::text AS path, 0 AS depth
          FROM meeting_categories k WHERE k.parent_id IS NULL
        UNION ALL
        SELECT k.id, k.name, k.parent_id, t.path || ' / ' || k.name, t.depth + 1
          FROM meeting_categories k JOIN tree t ON k.parent_id = t.id
    )
    SELECT t.id, t.name, t.parent_id, t.path, t.depth,
           (SELECT count(*) FROM meetings m WHERE m.category_id = t.id) AS meeting_count,
           (SELECT count(*) FROM meeting_categories c WHERE c.parent_id = t.id) AS child_count
    FROM tree t ORDER BY t.path
"""


class CategoryName(BaseModel):
    name: str
    # Optional and additive: an older caller that sends only a name still
    # creates a root category.
    parent_id: int | None = None


class CategoryParent(BaseModel):
    # null makes it a root. One field, one endpoint — the same shape
    # `/held-at` and `/category` use on a meeting.
    parent_id: int | None = None


def _clean(body: CategoryName) -> str:
    name = body.name.strip()[:NAME_MAX]
    if not name:
        raise HTTPException(400, "카테고리 이름을 입력하세요.")
    return name


def _would_cycle(c, category_id: int, parent_id: int) -> bool:
    """Is `parent_id` inside `category_id`'s own subtree?

    A CHECK constraint stops A -> A; only a walk can stop A -> B -> A. The walk
    is the same `SUBTREE` the meeting filter uses, so "descendant" means one
    thing in this application.
    """
    return any(
        r["id"] == parent_id
        for r in c.execute(SUBTREE, {"cat": category_id}).fetchall()
    )


@router.get("")
def list_categories():
    """The whole tree in path order, each row carrying what a delete would hit.

    `meeting_count` is direct assignments — how many meetings become 미분류 if
    this label goes. `child_count` is why a delete may be refused.
    """
    with conn() as c:
        return c.execute(TREE).fetchall()


@router.post("")
def create_category(body: CategoryName):
    name = _clean(body)
    try:
        with conn() as c:
            return c.execute(
                "INSERT INTO meeting_categories (name, parent_id) VALUES (%s,%s)"
                " RETURNING id, name, parent_id",
                (name, body.parent_id),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "같은 이름의 카테고리가 이미 있습니다.") from exc
    except ForeignKeyViolation as exc:
        raise HTTPException(400, "상위 카테고리를 찾을 수 없습니다.") from exc


@router.patch("/{category_id}")
def rename_category(category_id: int, body: CategoryName):
    """Rename only. Moving is `PUT /{id}/parent` — `parent_id` here is ignored,
    because a PATCH that omits a field must not read as "make it a root"."""
    name = _clean(body)
    try:
        with conn() as c:
            row = c.execute(
                "UPDATE meeting_categories SET name = %s, updated_at = now()"
                " WHERE id = %s RETURNING id, name, parent_id",
                (name, category_id),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "같은 이름의 카테고리가 이미 있습니다.") from exc
    if not row:
        raise HTTPException(404, "카테고리를 찾을 수 없습니다.")
    return row


@router.put("/{category_id}/parent")
def set_parent(category_id: int, body: CategoryParent):
    """Move a category under another one, or up to the root.

    Its meetings do not move: they keep the same `category_id`, and what changes
    is which parent query now reaches them.
    """
    with conn() as c:
        current = c.execute(
            "SELECT id FROM meeting_categories WHERE id = %s", (category_id,)
        ).fetchone()
        if not current:
            raise HTTPException(404, "카테고리를 찾을 수 없습니다.")
        if body.parent_id is not None:
            if body.parent_id == category_id:
                raise HTTPException(400, "자기 자신을 상위 카테고리로 지정할 수 없습니다.")
            if _would_cycle(c, category_id, body.parent_id):
                raise HTTPException(400, "하위 카테고리를 상위로 지정할 수 없습니다.")
        try:
            row = c.execute(
                "UPDATE meeting_categories SET parent_id = %s, updated_at = now()"
                " WHERE id = %s RETURNING id, name, parent_id",
                (body.parent_id, category_id),
            ).fetchone()
        except ForeignKeyViolation as exc:
            raise HTTPException(400, "상위 카테고리를 찾을 수 없습니다.") from exc
    return row


@router.delete("/{category_id}")
def delete_category(category_id: int):
    """Remove the label. Its meetings stay, with category_id back to NULL.

    A category with children is refused rather than cascaded: cascading would
    unfile every meeting under the whole subtree from a single click. The refusal
    names how many children are in the way, so the next action is obvious.
    """
    with conn() as c:
        children = c.execute(
            "SELECT count(*) AS n FROM meeting_categories WHERE parent_id = %s",
            (category_id,),
        ).fetchone()["n"]
        if children:
            raise HTTPException(
                409,
                f"하위 카테고리 {children}개가 있어 삭제할 수 없습니다. "
                "하위 카테고리를 먼저 옮기거나 삭제해 주세요.",
            )
        try:
            row = c.execute(
                "DELETE FROM meeting_categories WHERE id = %s RETURNING id", (category_id,)
            ).fetchone()
        except ForeignKeyViolation as exc:
            # A child appeared between the count and the delete. ON DELETE
            # RESTRICT is the real guard; the count above only writes the
            # friendlier sentence.
            raise HTTPException(409, "하위 카테고리가 있어 삭제할 수 없습니다.") from exc
    if not row:
        raise HTTPException(404, "카테고리를 찾을 수 없습니다.")
    return {"id": category_id, "deleted": True}
