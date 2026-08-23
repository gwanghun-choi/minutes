"""How one account has arranged its own screen.

A meeting is canonical: one recording, one transcript, one owner, one title that
only the upload sets. How it is *filed* is not — the owner's "업무 / 구매부" is
their filing of their own meeting, and a person the meeting was shared with may
reasonably keep it under "면접 준비 / 사례" and call it something else entirely.
Migration 011 splits those two things apart:

    user_categories       one tree per account
    user_meeting_filing   (account, meeting) -> that account's category and alias

Neither is ever visible to another account, and neither can change a word of the
meeting. Every query here is keyed on `%(auth_uid)s`, the same parameter
`access.READABLE` binds, so the personal layer and the permission layer are read
from one set of parameters and cannot disagree about who is asking.

This is organisation, never permission. `FILING` is a LEFT JOIN and nothing more:
a filing row is not a reason to show a meeting, and removing one is not a reason
to hide it. What a caller may read is `access.READABLE` and only that — see the
test that files a revoked meeting and still cannot open it.
"""
from fastapi import HTTPException

NAME_MAX = 40
ALIAS_MAX = 200

# This account's filing for a `meetings m` row, joined in. LEFT, always: most
# meetings have no filing, and a meeting stops being visible when access says so
# and never because a row here is missing.
FILING = (
    " LEFT JOIN user_meeting_filing uf"
    " ON uf.meeting_id = m.id AND uf.user_id = %(auth_uid)s"
)

# What this account calls the meeting. The canonical title is still selected
# beside it, so a screen can show both — "내 표시 이름" is a lens, not a rename.
DISPLAY_TITLE = "coalesce(uf.alias, m.title)"

# The personal columns every meeting-shaped response carries.
COLUMNS = f"""
    {DISPLAY_TITLE} AS display_title,
    uf.alias AS alias,
    uf.category_id AS category_id,
    uc.name AS category_name,
    uc.parent_id AS category_parent_id
"""
CATEGORY_JOIN = FILING + " LEFT JOIN user_categories uc ON uc.id = uf.category_id"

# "This category and everything under it", within one account's tree.
#
# The recursive step does not repeat the account check because it cannot escape:
# the composite foreign key in migration 011 carries `user_id` into every
# parent reference, so a subtree is one account's by construction. The root is
# checked, which is what makes an id belonging to somebody else return nothing.
SUBTREE = """
    WITH RECURSIVE sub AS (
        SELECT id FROM user_categories
         WHERE id = %(cat)s AND user_id = %(auth_uid)s
        UNION ALL
        SELECT k.id FROM user_categories k JOIN sub ON k.parent_id = sub.id
    )
    SELECT id FROM sub
"""

# One account's whole tree, pre-ordered by the rendered path.
#
# `meeting_count` is filings this account made *and* may still read: the second
# half is `access.READABLE`, pasted in, so a folder cannot count a meeting whose
# share was taken back. Filing something is not access to it.
TREE = """
    WITH RECURSIVE tree AS (
        SELECT k.id, k.name, k.parent_id, k.name::text AS path, 0 AS depth
          FROM user_categories k
         WHERE k.user_id = %(auth_uid)s AND k.parent_id IS NULL
        UNION ALL
        SELECT k.id, k.name, k.parent_id, t.path || ' / ' || k.name, t.depth + 1
          FROM user_categories k JOIN tree t ON k.parent_id = t.id
    )
    SELECT t.id, t.name, t.parent_id, t.path, t.depth,
           (SELECT count(*) FROM user_meeting_filing f
              JOIN meetings m ON m.id = f.meeting_id
             WHERE f.user_id = %(auth_uid)s AND f.category_id = t.id
               AND {readable}) AS meeting_count,
           (SELECT count(*) FROM user_categories c
             WHERE c.parent_id = t.id) AS child_count,
           (SELECT count(*) FROM chat_sessions s
             WHERE s.user_id = %(auth_uid)s AND s.category_id = t.id) AS chat_count
    FROM tree t ORDER BY t.path
"""


def clean_name(raw: str) -> str:
    name = raw.strip()[:NAME_MAX]
    if not name:
        raise HTTPException(400, "카테고리 이름을 입력하세요.")
    return name


def clean_alias(raw: str | None) -> str | None:
    """An empty alias is not a name — it is "go back to the meeting's own"."""
    return (raw or "").strip()[:ALIAS_MAX] or None


def owned(c, user_id: int, category_id: int | None, message="없는 카테고리입니다.") -> int | None:
    """`category_id` if this account owns it, None when it is None, else 400.

    The composite foreign key refuses somebody else's category anyway; this turns
    that refusal into a sentence, and does it before the write so an invalid id
    cannot be mistaken for "unfile it". 400 rather than 404: this is a value in a
    request body naming one of the caller's own folders, not a resource being
    addressed — the 404 belongs to the thing in the path.
    """
    if category_id is None:
        return None
    row = c.execute(
        "SELECT id FROM user_categories WHERE id = %s AND user_id = %s",
        (category_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(400, message)
    return category_id


def file_meeting(c, user_id: int, meeting_id: int, **fields) -> dict:
    """Upsert one (account, meeting) filing, changing only the fields given.

    One statement for insert and update: a filing row appears the first time an
    account files or renames anything, and an account that never does has no row
    at all. `COALESCE(%(x)s, ...)` cannot express "clear it", so each field is
    passed as (value, given) and the SET picks per column — which is what lets
    "카테고리 없음" and "이름 되돌리기" be ordinary values rather than a second
    endpoint.
    """
    args = {"uid": user_id, "mid": meeting_id}
    sets = []
    for column, value in fields.items():
        args[column] = value
        sets.append(f"{column} = EXCLUDED.{column}")
    columns = "".join(f", {c}" for c in fields)
    values = "".join(f", %({c})s" for c in fields)
    return c.execute(
        f"INSERT INTO user_meeting_filing (user_id, meeting_id{columns})"
        f" VALUES (%(uid)s, %(mid)s{values})"
        f" ON CONFLICT (user_id, meeting_id) DO UPDATE"
        f"   SET {', '.join(sets)}, updated_at = now()"
        f" RETURNING meeting_id, category_id, alias",
        args,
    ).fetchone()


def aliases(c, user_id: int, meeting_ids: list[int]) -> dict[int, str]:
    """meeting_id -> this account's alias, for the ones that have one.

    Applied when a stored source is read rather than when it is written, so an
    alias set today also renames the evidence in yesterday's answer. The stored
    payload keeps the canonical title it was retrieved with.
    """
    if not meeting_ids:
        return {}
    return {
        r["meeting_id"]: r["alias"]
        for r in c.execute(
            "SELECT meeting_id, alias FROM user_meeting_filing"
            " WHERE user_id = %s AND meeting_id = ANY(%s) AND alias IS NOT NULL",
            (user_id, list(meeting_ids)),
        ).fetchall()
    }
