"""Meeting categories, and the meeting date that comes with an upload.

Both are metadata about a meeting rather than a word of its transcript, so both
are editable at any status. The contracts worth pinning here are the ones the
database owns — a duplicate name is refused, and deleting a category unfiles its
meetings instead of deleting them — plus the one rule about legacy data: an
upload may propose today, but nothing backfills a meeting that never said when
it was held.
"""
import datetime as dt

import pytest
from conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def category(client):
    """Factory for throwaway categories. Removed at teardown, meetings intact."""
    from app.db import conn

    ids: list[int] = []

    def make(name: str, parent_id: int | None = None) -> dict:
        res = client.post(
            "/api/meeting-categories", json={"name": name, "parent_id": parent_id}
        )
        assert res.status_code == 200, res.text
        ids.append(res.json()["id"])
        return res.json()

    yield make

    # Reverse creation order, so a child always goes before its parent: the
    # parent FK is ON DELETE RESTRICT and is checked per row.
    with conn() as c:
        for cid in reversed(ids):
            c.execute("DELETE FROM meeting_categories WHERE id = %s", (cid,))


def _unique(name: str) -> str:
    import secrets

    return f"{name} {secrets.token_hex(4)}"


def test_a_category_is_created_and_listed(client, category):
    name = _unique("고객 미팅")
    made = category(name)
    assert made["name"] == name

    rows = client.get("/api/meeting-categories").json()["categories"]
    mine = next(r for r in rows if r["id"] == made["id"])
    assert mine["meeting_count"] == 0


def test_a_blank_name_is_refused(client):
    assert client.post("/api/meeting-categories", json={"name": "   "}).status_code == 400


def test_a_duplicate_name_is_a_conflict_not_a_second_row(client, category):
    name = _unique("개발")
    category(name)
    res = client.post("/api/meeting-categories", json={"name": name})
    assert res.status_code == 409
    assert "이미" in res.json()["detail"]


def test_a_category_can_be_renamed(client, category):
    made = category(_unique("내부 업무"))
    renamed = _unique("내부 운영")
    res = client.patch(f"/api/meeting-categories/{made['id']}", json={"name": renamed})
    assert res.status_code == 200
    assert res.json()["name"] == renamed


def test_renaming_onto_an_existing_name_is_a_conflict(client, category):
    first = category(_unique("A"))
    second = category(_unique("B"))
    res = client.patch(f"/api/meeting-categories/{second['id']}", json={"name": first["name"]})
    assert res.status_code == 409


def test_an_unknown_category_is_a_404(client):
    assert client.patch("/api/meeting-categories/0", json={"name": "x"}).status_code == 404
    assert client.delete("/api/meeting-categories/0").status_code == 404


def test_a_meeting_is_filed_and_unfiled(client, category, make_meeting):
    made = category(_unique("프로젝트 A"))
    mid = make_meeting("pytest 분류", [("SPEAKER_00", "분류 테스트입니다.")])

    res = client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})
    assert res.status_code == 200
    assert res.json() == {"id": mid, "category_id": made["id"], "category_name": made["name"]}

    # The list and the detail both carry it, so no screen has to look it up.
    # The list is paginated, so the row is fetched by the filter rather than by
    # scanning every page.
    listed = client.get("/api/meetings", params={"q": "pytest 분류"}).json()["items"]
    row = next(m for m in listed if m["id"] == mid)
    assert (row["category_id"], row["category_name"]) == (made["id"], made["name"])
    detail = client.get(f"/api/meetings/{mid}").json()["meeting"]
    assert detail["category_name"] == made["name"]

    cleared = client.put(f"/api/meetings/{mid}/category", json={"category_id": None})
    assert cleared.json() == {"id": mid, "category_id": None, "category_name": None}


def test_an_unknown_category_cannot_be_assigned(client, make_meeting):
    mid = make_meeting("pytest 잘못된 분류", [("SPEAKER_00", "테스트.")])
    res = client.put(f"/api/meetings/{mid}/category", json={"category_id": 2_000_000_000})
    assert res.status_code == 400


def test_deleting_a_category_leaves_its_meetings_alone(client, make_meeting):
    made = client.post("/api/meeting-categories", json={"name": _unique("삭제될 분류")}).json()
    mid = make_meeting("pytest 보존", [("SPEAKER_00", "회의는 남아야 합니다.")])
    client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})

    assert client.delete(f"/api/meeting-categories/{made['id']}").status_code == 200

    detail = client.get(f"/api/meetings/{mid}")
    assert detail.status_code == 200
    assert detail.json()["meeting"]["category_id"] is None
    assert detail.json()["meeting"]["category_name"] is None


def test_the_count_reflects_how_many_meetings_would_be_unfiled(client, category, make_meeting):
    made = category(_unique("계수"))
    mid = make_meeting("pytest 계수", [("SPEAKER_00", "하나.")])
    client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})

    rows = client.get("/api/meeting-categories").json()["categories"]
    assert next(r for r in rows if r["id"] == made["id"])["meeting_count"] == 1


# ---------- hierarchy ----------


def _listed(client, category_id: int) -> dict:
    rows = client.get("/api/meeting-categories").json()["categories"]
    return next(r for r in rows if r["id"] == category_id)


def test_a_child_category_carries_its_parent_its_depth_and_its_path(client, category):
    parent = category(_unique("업무"))
    child = category(_unique("개발"), parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]

    listed = _listed(client, child["id"])
    assert listed["depth"] == 1
    assert listed["path"] == f"{parent['name']} / {child['name']}"
    assert _listed(client, parent["id"]) == {
        **_listed(client, parent["id"]),
        "depth": 0,
        "parent_id": None,
        "child_count": 1,
    }


def test_an_existing_category_is_a_root_until_it_is_moved(client, category):
    made = category(_unique("고객"))
    assert made["parent_id"] is None
    assert _listed(client, made["id"])["depth"] == 0


def test_a_category_can_be_moved_under_another_and_back_to_the_root(client, category):
    parent = category(_unique("업무"))
    moved = category(_unique("운영"))

    res = client.put(f"/api/meeting-categories/{moved['id']}/parent",
                     json={"parent_id": parent["id"]})
    assert res.status_code == 200 and res.json()["parent_id"] == parent["id"]
    assert _listed(client, moved["id"])["depth"] == 1

    back = client.put(f"/api/meeting-categories/{moved['id']}/parent",
                      json={"parent_id": None})
    assert back.status_code == 200 and back.json()["parent_id"] is None
    assert _listed(client, moved["id"])["depth"] == 0


def test_moving_a_category_does_not_move_its_meetings(client, category, make_meeting):
    parent = category(_unique("업무"))
    child = category(_unique("개발"))
    mid = make_meeting("pytest 이동", [("SPEAKER_00", "이동 테스트.")])
    client.put(f"/api/meetings/{mid}/category", json={"category_id": child["id"]})

    client.put(f"/api/meeting-categories/{child['id']}/parent",
               json={"parent_id": parent["id"]})

    detail = client.get(f"/api/meetings/{mid}").json()["meeting"]
    assert detail["category_id"] == child["id"]
    assert detail["category_name"] == child["name"]


def test_a_category_cannot_become_its_own_parent(client, category):
    made = category(_unique("자기참조"))
    res = client.put(f"/api/meeting-categories/{made['id']}/parent",
                     json={"parent_id": made["id"]})
    assert res.status_code == 400
    assert _listed(client, made["id"])["parent_id"] is None


def test_a_cycle_through_a_descendant_is_refused(client, category):
    """A -> B -> C, then asking A to sit under C. Refused, tree untouched."""
    a = category(_unique("A"))
    b = category(_unique("B"), parent_id=a["id"])
    c = category(_unique("C"), parent_id=b["id"])

    res = client.put(f"/api/meeting-categories/{a['id']}/parent", json={"parent_id": c["id"]})
    assert res.status_code == 400
    assert "하위" in res.json()["detail"]
    assert _listed(client, a["id"])["parent_id"] is None
    assert _listed(client, c["id"])["path"].endswith(f"{b['name']} / {c['name']}")


def test_an_unknown_parent_is_refused_on_create_and_on_move(client, category):
    res = client.post(
        "/api/meeting-categories",
        json={"name": _unique("고아"), "parent_id": 2_000_000_000},
    )
    assert res.status_code == 400

    made = category(_unique("이동 대상"))
    moved = client.put(f"/api/meeting-categories/{made['id']}/parent",
                       json={"parent_id": 2_000_000_000})
    assert moved.status_code == 400


def test_a_parent_with_children_is_not_deleted(client, category):
    parent = category(_unique("업무"))
    child = category(_unique("개발"), parent_id=parent["id"])

    res = client.delete(f"/api/meeting-categories/{parent['id']}")
    assert res.status_code == 409
    assert "하위 카테고리" in res.json()["detail"]
    # both are still there, and so is the relationship
    assert _listed(client, child["id"])["parent_id"] == parent["id"]

    # emptying it first is what makes the delete possible
    client.put(f"/api/meeting-categories/{child['id']}/parent", json={"parent_id": None})
    assert client.delete(f"/api/meeting-categories/{parent['id']}").status_code == 200


def test_moving_a_category_needs_a_session(anon):
    assert anon.put("/api/meeting-categories/1/parent",
                    json={"parent_id": None}).status_code == 401


def test_categories_need_a_session(anon):
    assert anon.get("/api/meeting-categories").status_code == 401
    assert anon.post("/api/meeting-categories", json={"name": "x"}).status_code == 401


# ---------- held_at on upload ----------


def _upload(client, **form):
    """A one-byte .wav is enough: the response is written before analysis runs."""
    return client.post(
        "/api/meetings",
        files={"file": ("pytest-held.wav", b"\x00", "audio/wav")},
        data=form,
    )


@pytest.fixture
def uploaded():
    """Cleans up whatever an upload test created, row and file both."""
    from app.db import conn
    from app.services import audio

    ids: list[int] = []
    yield ids
    with conn() as c:
        for row in c.execute(
            "DELETE FROM meetings WHERE id = ANY(%s) RETURNING stored_filename", (ids,)
        ).fetchall():
            for path in audio.meeting_files(row["stored_filename"]):
                path.unlink(missing_ok=True)


def test_an_upload_can_carry_the_meeting_date(client, uploaded):
    res = _upload(client, title="pytest 일시 있음", held_at="2026-08-18T14:30:00+09:00")
    assert res.status_code == 200, res.text
    uploaded.append(res.json()["id"])
    assert dt.datetime.fromisoformat(res.json()["held_at"]) == dt.datetime(
        2026, 8, 18, 5, 30, tzinfo=dt.timezone.utc
    )


def test_an_upload_without_a_date_stays_null(client, uploaded):
    """No DB default of now(): an unstated meeting date is NULL, not the upload
    time wearing a different name."""
    res = _upload(client, title="pytest 일시 없음")
    assert res.status_code == 200, res.text
    uploaded.append(res.json()["id"])
    assert res.json()["held_at"] is None

    blank = _upload(client, title="pytest 빈 일시", held_at="")
    uploaded.append(blank.json()["id"])
    assert blank.json()["held_at"] is None


def test_a_malformed_date_is_refused_rather_than_guessed(client):
    res = _upload(client, title="pytest 잘못된 일시", held_at="지난주 화요일")
    assert res.status_code == 400


def test_a_legacy_meeting_keeps_a_null_held_at(client, make_meeting):
    """make_meeting with no held_ago is the legacy shape. Nothing in the upload
    or category paths may fill it in."""
    mid = make_meeting("pytest legacy", [("SPEAKER_00", "예전 회의입니다.")])
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"] is None

    # Filing it does not invent a date either.
    made = client.post("/api/meeting-categories", json={"name": _unique("legacy")}).json()
    client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"] is None
    client.delete(f"/api/meeting-categories/{made['id']}")


# ---------- the two fixed navigation rows: 전체 회의 and 미분류 ----------

LINES = [("SPEAKER_00", "카운트 확인용 발화입니다.")]


def _nav(c) -> tuple[int, int]:
    """(전체 회의, 미분류) as the sidebar reads them."""
    body = c.get("/api/meeting-categories").json()
    return body["total"], body["uncategorized"]


def test_a_new_account_sees_zero_in_both_navigation_rows(client):
    assert _nav(client) == (0, 0)


def test_total_is_what_the_meeting_list_totals(client, make_meeting):
    """The same number, because both are `access.READABLE` over `meetings`.

    A sidebar count that disagreed with the page it links to is worse than no
    count, so this asserts the agreement rather than a literal.
    """
    make_meeting("pytest 카운트 1", LINES, status="REVIEW_REQUIRED")
    make_meeting("pytest 카운트 2", LINES, status="REVIEW_REQUIRED")

    total, unfiled = _nav(client)
    assert total == 2 and unfiled == 2
    assert client.get("/api/meetings").json()["total"] == total
    assert client.get("/api/meetings", params={"category": "none"}).json()["total"] == unfiled


def test_filing_a_meeting_moves_it_from_미분류_into_its_folder(client, make_meeting, category):
    mid = make_meeting("pytest 이동", LINES, status="REVIEW_REQUIRED")
    cat = category(_unique("카운트 폴더"))
    assert _nav(client) == (1, 1)

    client.put(f"/api/meetings/{mid}/category", json={"category_id": cat["id"]})

    body = client.get("/api/meeting-categories").json()
    assert (body["total"], body["uncategorized"]) == (1, 0)   # total unchanged
    assert next(r for r in body["categories"] if r["id"] == cat["id"])["meeting_count"] == 1

    # and back again
    client.put(f"/api/meetings/{mid}/category", json={"category_id": None})
    assert _nav(client) == (1, 1)


def test_an_alias_without_a_folder_is_still_미분류(client, make_meeting):
    """미분류 is "filed in no category", not "has no filing row".

    Renaming a meeting for myself leaves a `user_meeting_filing` row with a NULL
    category, and that meeting is still unfiled — which is why the predicate is
    written as the absence of a *categorised* filing.
    """
    mid = make_meeting("pytest 별칭만", LINES, status="REVIEW_REQUIRED")
    client.put(f"/api/meetings/{mid}/alias", json={"alias": "내가 부르는 이름"})
    assert _nav(client) == (1, 1)


def test_deleting_a_meeting_takes_it_out_of_both_counts(client, make_meeting):
    mid = make_meeting("pytest 삭제", LINES, status="REVIEW_REQUIRED")
    assert _nav(client) == (1, 1)
    assert client.delete(f"/api/meetings/{mid}").status_code == 200
    assert _nav(client) == (0, 0)


def test_an_accepted_share_counts_for_the_recipient(client, make_meeting, login, share):
    mid = make_meeting("pytest 공유 카운트", LINES, status="REVIEW_REQUIRED")
    reader = login()
    assert _nav(reader) == (0, 0)

    share(mid, reader.account["id"])
    assert _nav(reader) == (1, 1)
    assert _nav(client) == (1, 1)   # the owner still counts it once


def test_an_invitation_counts_only_once_it_has_been_accepted(
    client, make_meeting, login, share
):
    """PENDING, REJECTED, and REVOKED are all "not readable", and a count is
    information: a number that moved on invitation would announce a meeting the
    recipient may not open."""
    mid = make_meeting("pytest 초대 카운트", LINES, status="REVIEW_REQUIRED")
    reader = login()

    for status in ("PENDING", "REJECTED", "REVOKED"):
        share(mid, reader.account["id"], status=status)
        assert _nav(reader) == (0, 0), status

    share(mid, reader.account["id"], status="ACCEPTED")
    assert _nav(reader) == (1, 1)


def test_somebody_elses_meeting_is_in_nobody_elses_count(client, make_meeting, accounts):
    stranger = accounts()
    make_meeting("pytest 남의 회의", LINES, status="REVIEW_REQUIRED", owner=stranger["id"])
    assert _nav(client) == (0, 0)


def test_owner_and_reader_file_one_meeting_into_two_different_places(
    client, make_meeting, login, share, category
):
    mid = make_meeting("pytest 각자 정리", LINES, status="REVIEW_REQUIRED")
    cat = category(_unique("내 폴더"))
    client.put(f"/api/meetings/{mid}/category", json={"category_id": cat["id"]})

    reader = login()
    share(mid, reader.account["id"])

    assert _nav(client) == (1, 0)    # filed, for me
    assert _nav(reader) == (1, 1)    # unfiled, for them — their tree is empty
    assert reader.get("/api/meeting-categories").json()["categories"] == []


def test_the_total_is_not_a_page_and_is_never_truncated(client):
    """105 meetings, a page of 20, and the count still says 105.

    `99+` is a rendering decision and belongs to the browser; the API returns the
    real number so paging, caching, and the accessible name all still have it.
    """
    from app.db import conn

    with conn() as c:
        c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status,"
            " owner_user_id)"
            " SELECT 'pytest 대량 ' || g, 'x.wav', 'x.wav', 'COMPLETED', %s"
            "   FROM generate_series(1, 105) AS g",
            (client.account["id"],),
        )
    try:
        assert _nav(client) == (105, 105)
        page = client.get("/api/meetings", params={"page_size": 20}).json()
        assert len(page["items"]) == 20
        assert page["total"] == 105
    finally:
        with conn() as c:
            c.execute(
                "DELETE FROM meetings WHERE owner_user_id = %s", (client.account["id"],)
            )
