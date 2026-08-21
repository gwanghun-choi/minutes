"""Meeting categories.

A flat list of labels, one per meeting at most. `meetings.category_id` is a
nullable FK with ON DELETE SET NULL, so NULL is 미분류 and deleting a category
never deletes a meeting — PostgreSQL carries both rules, not this module.

No roles and no ownership: every logged-in user sees and edits the same list,
exactly like meetings.
"""
from fastapi import APIRouter, HTTPException
from psycopg.errors import UniqueViolation
from pydantic import BaseModel

from app.db import conn

router = APIRouter(prefix="/api/meeting-categories", tags=["categories"])

NAME_MAX = 40


class CategoryName(BaseModel):
    name: str


def _clean(body: CategoryName) -> str:
    name = body.name.strip()[:NAME_MAX]
    if not name:
        raise HTTPException(400, "카테고리 이름을 입력하세요.")
    return name


@router.get("")
def list_categories():
    """Every category with how many meetings carry it, name order.

    The count is what makes a delete an informed click: it says how many
    meetings are about to become 미분류.
    """
    with conn() as c:
        return c.execute(
            "SELECT k.id, k.name,"
            " (SELECT count(*) FROM meetings m WHERE m.category_id = k.id) AS meeting_count"
            " FROM meeting_categories k ORDER BY k.name"
        ).fetchall()


@router.post("")
def create_category(body: CategoryName):
    name = _clean(body)
    try:
        with conn() as c:
            return c.execute(
                "INSERT INTO meeting_categories (name) VALUES (%s) RETURNING id, name",
                (name,),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "같은 이름의 카테고리가 이미 있습니다.") from exc


@router.patch("/{category_id}")
def rename_category(category_id: int, body: CategoryName):
    name = _clean(body)
    try:
        with conn() as c:
            row = c.execute(
                "UPDATE meeting_categories SET name = %s, updated_at = now()"
                " WHERE id = %s RETURNING id, name",
                (name, category_id),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "같은 이름의 카테고리가 이미 있습니다.") from exc
    if not row:
        raise HTTPException(404, "카테고리를 찾을 수 없습니다.")
    return row


@router.delete("/{category_id}")
def delete_category(category_id: int):
    """Remove the label. Its meetings stay, with category_id back to NULL."""
    with conn() as c:
        row = c.execute(
            "DELETE FROM meeting_categories WHERE id = %s RETURNING id", (category_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "카테고리를 찾을 수 없습니다.")
    return {"id": category_id, "deleted": True}
