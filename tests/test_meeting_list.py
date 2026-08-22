"""The meeting list: one page at a time, narrowed by the database.

Filtering used to happen in the browser over the whole list. It cannot any more —
a page is all that arrives — so these tests pin the two things that replaced it:
the filter and the total describe the same set, and a category means that
category *and everything under it*.

The database is shared, so nothing here asserts an absolute total. Every test
narrows to meetings it created itself (`pytest-list` in the title) and counts
inside that.
"""
import pytest
from conftest import requires_db

pytestmark = requires_db

TAG = "pytest-list"


@pytest.fixture
def listed(client, make_meeting):
    """N approved meetings this test owns, newest held_at first.

    `held_ago` is what the default sort reads, so the order is fixed rather than
    depending on when the rows happened to be inserted.
    """

    def make(n: int, status: str = "COMPLETED") -> list[int]:
        return [
            make_meeting(f"{TAG} {i:02d}", [("SPEAKER_00", f"{i}번 회의입니다.")],
                         status=status, held_ago=i + 1)
            for i in range(n)
        ]

    return make


def page(client, **params) -> dict:
    res = client.get("/api/meetings", params={"q": TAG, **params})
    assert res.status_code == 200, res.text
    return res.json()


def titles(body: dict) -> list[str]:
    return [m["title"] for m in body["items"]]


def test_the_list_is_a_page_with_the_total_the_filter_matched(client, listed):
    listed(5)
    body = page(client, page_size=2)
    assert body["page"] == 1 and body["page_size"] == 2
    assert body["total"] == 5
    assert len(body["items"]) == 2


def test_the_pages_together_are_the_whole_filtered_set_and_nothing_twice(client, listed):
    listed(5)
    seen = []
    for n in (1, 2, 3):
        body = page(client, page_size=2, page=n)
        assert body["total"] == 5
        seen += titles(body)
    # held_ago grows with the index, so newest-first is 00, 01, 02 …
    assert seen == sorted(seen)                        # one continuous ordering
    assert len(set(seen)) == 5


def test_a_page_past_the_end_is_empty_but_still_reports_the_real_total(client, listed):
    listed(3)
    body = page(client, page_size=2, page=9)
    assert body["items"] == []
    assert body["total"] == 3          # so the browser can correct itself


def test_page_zero_and_a_silly_size_are_clamped_rather_than_refused(client, listed):
    listed(3)
    body = page(client, page=0, page_size=0)
    assert (body["page"], body["page_size"]) == (1, 1)
    assert len(body["items"]) == 1

    huge = page(client, page_size=10_000)
    assert huge["page_size"] == 100     # PAGE_SIZE_MAX


def test_the_default_page_size_is_twenty(client, listed):
    listed(1)
    assert page(client)["page_size"] == 20


@pytest.mark.parametrize("sort,first", [("held_desc", "00"), ("held_asc", "04")])
def test_sorting_happens_in_the_database_not_on_the_page(client, listed, sort, first):
    """`held_ago` grows with the index, so 00 is the most recent meeting."""
    listed(5)
    body = page(client, sort=sort, page_size=2)
    assert titles(body)[0] == f"{TAG} {first}"


def test_an_unknown_sort_or_status_is_a_400(client):
    assert client.get("/api/meetings", params={"sort": "id_desc"}).status_code == 400
    assert client.get("/api/meetings", params={"status": "SLEEPING"}).status_code == 400


def test_the_status_filter_and_the_total_agree(client, listed):
    listed(2)
    listed(1)  # a second batch, so the tag matches three meetings
    drafts = client.get(
        "/api/meetings", params={"q": TAG, "status": "REVIEW_REQUIRED"}
    ).json()
    assert drafts["total"] == len(drafts["items"])
    assert all(m["status"] == "REVIEW_REQUIRED" for m in drafts["items"])


def test_a_search_term_narrows_the_total_too(client, listed):
    listed(4)
    body = client.get("/api/meetings", params={"q": f"{TAG} 02"}).json()
    assert body["total"] == 1
    assert titles(body) == [f"{TAG} 02"]


def test_the_period_filter_reads_the_meeting_date(client, make_meeting):
    recent = make_meeting(f"{TAG} 최근", [("SPEAKER_00", "최근.")], held_ago=2)
    old = make_meeting(f"{TAG} 오래됨", [("SPEAKER_00", "오래됨.")], held_ago=400)

    body = page(client, days=30, page_size=100)
    ids = {m["id"] for m in body["items"]}
    assert recent in ids
    assert old not in ids
    assert body["total"] == len(body["items"])


def test_a_filter_and_a_page_apply_together(client, listed):
    listed(4, status="REVIEW_REQUIRED")
    listed(2)
    body = page(client, status="REVIEW_REQUIRED", page_size=3, page=2)
    assert body["total"] == 4
    assert len(body["items"]) == 1
    assert all(m["status"] == "REVIEW_REQUIRED" for m in body["items"])


# ---------- category, including everything under it ----------


@pytest.fixture
def tree(client):
    """업무 / (개발, 운영) — removed at teardown, children first."""
    from app.db import conn

    import secrets

    made: list[dict] = []

    def add(name: str, parent_id: int | None = None) -> dict:
        row = client.post(
            "/api/meeting-categories",
            json={"name": f"{name} {secrets.token_hex(4)}", "parent_id": parent_id},
        ).json()
        made.append(row)
        return row

    parent = add("업무")
    nodes = {
        "parent": parent,
        "dev": add("개발", parent["id"]),
        "ops": add("운영", parent["id"]),
        "other": add("개인"),
    }
    yield nodes

    with conn() as c:
        for row in reversed(made):
            c.execute("DELETE FROM meeting_categories WHERE id = %s", (row["id"],))


def test_a_leaf_category_returns_only_its_own_meetings(client, listed, tree):
    a, b = listed(2)
    client.put(f"/api/meetings/{a}/category", json={"category_id": tree["dev"]["id"]})
    client.put(f"/api/meetings/{b}/category", json={"category_id": tree["ops"]["id"]})

    body = page(client, category=tree["dev"]["id"], page_size=100)
    assert {m["id"] for m in body["items"]} == {a}
    assert body["total"] == 1


def test_a_parent_category_returns_its_descendants_meetings(client, listed, tree):
    """The filter a parent selection has to mean. Nothing is re-filed to make it
    work: each meeting keeps the one category it was given."""
    a, b, c = listed(3)
    client.put(f"/api/meetings/{a}/category", json={"category_id": tree["dev"]["id"]})
    client.put(f"/api/meetings/{b}/category", json={"category_id": tree["ops"]["id"]})
    client.put(f"/api/meetings/{c}/category", json={"category_id": tree["parent"]["id"]})

    body = page(client, category=tree["parent"]["id"], page_size=100)
    assert {m["id"] for m in body["items"]} == {a, b, c}
    assert body["total"] == 3
    # and each row still reports the category it is actually filed in
    filed = {m["id"]: m["category_id"] for m in body["items"]}
    assert filed[a] == tree["dev"]["id"]


def test_a_sibling_subtree_is_not_included(client, listed, tree):
    a, b = listed(2)
    client.put(f"/api/meetings/{a}/category", json={"category_id": tree["dev"]["id"]})
    client.put(f"/api/meetings/{b}/category", json={"category_id": tree["other"]["id"]})

    body = page(client, category=tree["parent"]["id"], page_size=100)
    assert {m["id"] for m in body["items"]} == {a}


def test_a_deeper_descendant_is_reached_too(client, listed, tree):
    """업무 / 개발 / 백엔드 — the walk is recursive, not one level."""
    deep = client.post(
        "/api/meeting-categories",
        json={"name": f"{TAG} 백엔드", "parent_id": tree["dev"]["id"]},
    ).json()
    try:
        mid = listed(1)[0]
        client.put(f"/api/meetings/{mid}/category", json={"category_id": deep["id"]})
        body = page(client, category=tree["parent"]["id"], page_size=100)
        assert mid in {m["id"] for m in body["items"]}
    finally:
        client.delete(f"/api/meeting-categories/{deep['id']}")


def test_none_is_the_unfiled_meetings(client, listed, tree):
    a, b = listed(2)
    client.put(f"/api/meetings/{a}/category", json={"category_id": tree["dev"]["id"]})

    body = page(client, category="none", page_size=100)
    ids = {m["id"] for m in body["items"]}
    assert b in ids and a not in ids


def test_a_category_that_is_not_a_number_is_a_400(client):
    assert client.get("/api/meetings", params={"category": "업무"}).status_code == 400
