"""Categories: one tree per account, for arranging that account's own screen.

A category used to be a global word and `meetings.category_id` used to be a
property of the recording. Sharing made both wrong at once — the owner's filing
turned up on the reader's screen as a fact about the meeting, and the reader had
no folder of their own to put it in. Migration 011 moved filing onto the pair
(account, meeting); this router is the account's half of it.

Every statement here is keyed on the caller. There is no cross-account read, no
shared vocabulary, and no way to name somebody else's category: the composite
foreign key in migration 011 carries `user_id` into every reference, so the
database refuses one even if this code forgot to check.

What has *not* changed: a meeting is filed in at most one category, the tree
changes what a query means rather than what an assignment means (`SUBTREE`), and
a parent with children is refused rather than cascaded. Those rules are the same
ones migration 006 and 008 established — they now apply per account.
"""
from fastapi import APIRouter, HTTPException, Request
from psycopg.errors import ForeignKeyViolation, UniqueViolation
from pydantic import BaseModel

from app.db import conn
from app.services import access, organization

router = APIRouter(prefix="/api/meeting-categories", tags=["categories"])

SUBTREE = organization.SUBTREE


class CategoryName(BaseModel):
    name: str
    parent_id: int | None = None


class CategoryParent(BaseModel):
    # null makes it a root. One field, one endpoint.
    parent_id: int | None = None


def _would_cycle(c, user_id: int, category_id: int, parent_id: int) -> bool:
    """Is `parent_id` inside `category_id`'s own subtree?

    A CHECK constraint stops A -> A; only a walk can stop A -> B -> A. The walk
    is the same `SUBTREE` the meeting filter uses, so "descendant" means one
    thing in this application.
    """
    return any(
        r["id"] == parent_id
        for r in c.execute(SUBTREE, {"cat": category_id, "auth_uid": user_id}).fetchall()
    )


def _addressed(c, user_id: int, category_id: int) -> None:
    """The category in the path. 404 when it is not this account's — to the
    caller there is no difference between somebody else's and none at all."""
    if not c.execute(
        "SELECT 1 FROM user_categories WHERE id = %s AND user_id = %s",
        (category_id, user_id),
    ).fetchone():
        raise HTTPException(404, "카테고리를 찾을 수 없습니다.")


def _parent(c, user_id: int, parent_id: int | None) -> int | None:
    """A parent named in a body. 400, like any other unusable value in one."""
    return organization.owned(c, user_id, parent_id, "상위 카테고리를 찾을 수 없습니다.")


@router.get("")
def list_categories(request: Request):
    """This account's whole tree in path order, with what each row holds.

    `meeting_count` is what this account filed there *and* may still read — the
    counts are taken through `access.READABLE`, so a folder never counts a
    meeting whose share has been taken back. `chat_count` is the same idea for
    conversations, which are owned outright and so need no second predicate.

    `child_count` is why a delete may be refused.
    """
    with conn() as c:
        return c.execute(
            organization.TREE.format(readable=access.READABLE),
            access.params(request.state.user["id"]),
        ).fetchall()


@router.post("")
def create_category(request: Request, body: CategoryName):
    user_id = request.state.user["id"]
    name = organization.clean_name(body.name)
    try:
        with conn() as c:
            _parent(c, user_id, body.parent_id)
            return c.execute(
                "INSERT INTO user_categories (user_id, name, parent_id) VALUES (%s,%s,%s)"
                " RETURNING id, name, parent_id",
                (user_id, name, body.parent_id),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "같은 이름의 카테고리가 이미 있습니다.") from exc


@router.patch("/{category_id}")
def rename_category(request: Request, category_id: int, body: CategoryName):
    """Rename only. Moving is `PUT /{id}/parent` — `parent_id` here is ignored,
    because a PATCH that omits a field must not read as "make it a root"."""
    name = organization.clean_name(body.name)
    try:
        with conn() as c:
            row = c.execute(
                "UPDATE user_categories SET name = %s, updated_at = now()"
                " WHERE id = %s AND user_id = %s RETURNING id, name, parent_id",
                (name, category_id, request.state.user["id"]),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "같은 이름의 카테고리가 이미 있습니다.") from exc
    if not row:
        raise HTTPException(404, "카테고리를 찾을 수 없습니다.")
    return row


@router.put("/{category_id}/parent")
def set_parent(request: Request, category_id: int, body: CategoryParent):
    """Move a category under another one, or up to the root.

    Its meetings do not move: they keep the filing they had, and what changes is
    which parent query now reaches them.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        _addressed(c, user_id, category_id)
        if body.parent_id is not None:
            _parent(c, user_id, body.parent_id)
            if body.parent_id == category_id:
                raise HTTPException(400, "자기 자신을 상위 카테고리로 지정할 수 없습니다.")
            if _would_cycle(c, user_id, category_id, body.parent_id):
                raise HTTPException(400, "하위 카테고리를 상위로 지정할 수 없습니다.")
        try:
            row = c.execute(
                "UPDATE user_categories SET parent_id = %s, updated_at = now()"
                " WHERE id = %s AND user_id = %s RETURNING id, name, parent_id",
                (body.parent_id, category_id, user_id),
            ).fetchone()
        except ForeignKeyViolation as exc:
            raise HTTPException(400, "상위 카테고리를 찾을 수 없습니다.") from exc
    return row


@router.delete("/{category_id}")
def delete_category(request: Request, category_id: int):
    """Remove the folder. What was in it stays, unfiled.

    A category with children is refused rather than cascaded: cascading would
    unfile everything under the whole subtree from a single click.

    Nothing filed there is deleted — the filings and conversations are cleared to
    NULL first, in the same transaction, which is also why the foreign keys are
    RESTRICT. An alias set beside the category survives the folder going: they
    are two separate things a person chose, and removing one must not remove the
    other.
    """
    user_id = request.state.user["id"]
    with conn() as c:
        _addressed(c, user_id, category_id)
        children = c.execute(
            "SELECT count(*) AS n FROM user_categories WHERE parent_id = %s AND user_id = %s",
            (category_id, user_id),
        ).fetchone()["n"]
        if children:
            raise HTTPException(
                409,
                f"하위 카테고리 {children}개가 있어 삭제할 수 없습니다. "
                "하위 카테고리를 먼저 옮기거나 삭제해 주세요.",
            )
        c.execute(
            "UPDATE user_meeting_filing SET category_id = NULL, updated_at = now()"
            " WHERE user_id = %s AND category_id = %s",
            (user_id, category_id),
        )
        c.execute(
            "UPDATE chat_sessions SET category_id = NULL"
            " WHERE user_id = %s AND category_id = %s",
            (user_id, category_id),
        )
        c.execute(
            "DELETE FROM user_categories WHERE id = %s AND user_id = %s",
            (category_id, user_id),
        )
    return {"id": category_id, "deleted": True}
