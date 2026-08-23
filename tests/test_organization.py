"""Personal organisation: how one account arranged its own screen.

The rule these tests exist to hold is a separation, not a permission:

    canonical   the recording, its transcript, its speakers, its title, its
                owner. Shared, and only the owner writes it.
    personal    which folder it is in and what this account calls it. One row
                per (account, meeting), and nobody else's business.

So the same meeting can be 업무/구매부 "8월 구매부 정산 회의" to the person who
uploaded it and 면접준비/사례 "정산 프로세스 참고" to the person they shared it
with, at the same time, with neither able to see the other's arrangement.

The other rule is that organisation is never access. Filing a meeting does not
make it readable, and a filing row left behind after a revoke does not either —
`access.READABLE` is the only thing that decides, and every test that could
confuse the two checks both.
"""
import pytest
from conftest import requires_db

pytestmark = requires_db

TAG = "pytest-org"
LINES = [
    ("SPEAKER_00", "정산 프로세스를 정리해 주세요."),
    ("SPEAKER_01", "8월 말까지 정리하겠습니다."),
]


@pytest.fixture
def folders(client):
    """Make categories for whoever asks, and clean up whatever was made."""
    made: list[tuple] = []

    def make(c, name: str, parent_id: int | None = None) -> dict:
        row = c.post("/api/meeting-categories",
                     json={"name": f"{TAG}-{name}", "parent_id": parent_id}).json()
        made.append((c, row["id"]))
        return row

    yield make
    for c, cid in reversed(made):
        c.delete(f"/api/meeting-categories/{cid}")


def tree(c) -> dict[str, int]:
    return {k["path"]: k["id"] for k in c.get("/api/meeting-categories").json()["categories"]}


def listed(c, **params) -> list[dict]:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return c.get(f"/api/meetings?{query}" if query else "/api/meetings").json()["items"]


# ------------------------------------------------------------ two trees


def test_two_accounts_have_two_trees_that_never_meet(client, login, folders):
    other = login()
    mine = folders(client, "업무")
    theirs = folders(other, "면접준비")

    assert f"{TAG}-업무" in tree(client)
    assert f"{TAG}-업무" not in tree(other)
    assert f"{TAG}-면접준비" in tree(other)
    assert f"{TAG}-면접준비" not in tree(client)

    # …and neither can address the other's, by id or by name
    assert other.patch(f"/api/meeting-categories/{mine['id']}",
                       json={"name": "가로채기"}).status_code == 404
    assert other.delete(f"/api/meeting-categories/{mine['id']}").status_code == 404
    assert client.put(f"/api/meeting-categories/{mine['id']}/parent",
                      json={"parent_id": theirs["id"]}).status_code == 400


def test_the_same_name_is_free_for_everybody_and_taken_once_each(client, login, folders):
    other = login()
    folders(client, "업무")
    folders(other, "업무")            # the same word, a different folder
    assert client.post("/api/meeting-categories",
                       json={"name": f"{TAG}-업무"}).status_code == 409


def test_a_subtree_filter_only_walks_my_own_tree(client, login, folders, make_meeting):
    parent = folders(client, "고객사")
    child = folders(client, "고객사-A", parent_id=parent["id"])
    mid = make_meeting(f"{TAG} 고객사 회의", LINES)
    client.put(f"/api/meetings/{mid}/category", json={"category_id": child["id"]})

    assert [m["id"] for m in listed(client, category=parent["id"])] == [mid]
    assert [m["id"] for m in listed(client, category=child["id"])] == [mid]
    # somebody else asking for that category id gets their own empty answer
    assert listed(login(), category=parent["id"]) == []


# --------------------------------------------------- the same meeting, twice


@pytest.fixture
def shared_meeting(client, login, make_meeting, share):
    """An approved meeting the owner has shared. -> (owner, reader, meeting_id)"""
    mid = make_meeting(f"{TAG} 8월 구매부 정산 회의", LINES)
    reader = login()
    share(mid, reader.account["id"])
    return client, reader, mid


def test_one_meeting_is_filed_and_named_twice_without_either_side_moving(
    shared_meeting, folders,
):
    owner, reader, mid = shared_meeting
    mine = folders(owner, "구매부")
    theirs = folders(reader, "면접준비")

    owner.put(f"/api/meetings/{mid}/category", json={"category_id": mine["id"]})
    reader.put(f"/api/meetings/{mid}/category", json={"category_id": theirs["id"]})
    reader.put(f"/api/meetings/{mid}/alias", json={"alias": "정산 프로세스 참고"})

    m = owner.get(f"/api/meetings/{mid}").json()["meeting"]
    assert (m["category_id"], m["display_title"]) == (mine["id"], f"{TAG} 8월 구매부 정산 회의")
    t = reader.get(f"/api/meetings/{mid}").json()["meeting"]
    assert (t["category_id"], t["display_title"]) == (theirs["id"], "정산 프로세스 참고")
    # the recording's own name never moved for anybody
    assert m["title"] == t["title"] == f"{TAG} 8월 구매부 정산 회의"


def test_an_alias_is_a_lens_and_clearing_it_goes_back_to_the_real_title(shared_meeting):
    owner, reader, mid = shared_meeting
    canonical = owner.get(f"/api/meetings/{mid}").json()["meeting"]["title"]

    reader.put(f"/api/meetings/{mid}/alias", json={"alias": "  내 이름  "})
    row = reader.get(f"/api/meetings/{mid}").json()["meeting"]
    assert (row["alias"], row["display_title"]) == ("내 이름", "내 이름")

    # an empty string is "use the meeting's own", not a name made of spaces
    reader.put(f"/api/meetings/{mid}/alias", json={"alias": "   "})
    row = reader.get(f"/api/meetings/{mid}").json()["meeting"]
    assert (row["alias"], row["display_title"]) == (None, canonical)


def test_the_list_carries_each_account_its_own_name_and_folder(shared_meeting, folders):
    owner, reader, mid = shared_meeting
    theirs = folders(reader, "사례")
    reader.put(f"/api/meetings/{mid}/category", json={"category_id": theirs["id"]})
    reader.put(f"/api/meetings/{mid}/alias", json={"alias": "정산 사례"})

    row = next(m for m in listed(reader) if m["id"] == mid)
    assert row["display_title"] == "정산 사례"
    assert row["category_name"] == f"{TAG}-사례"
    mine = next(m for m in listed(owner) if m["id"] == mid)
    assert mine["display_title"] == f"{TAG} 8월 구매부 정산 회의"
    assert mine["category_name"] is None


def test_a_reader_filing_a_meeting_does_not_change_the_owners_list(shared_meeting, folders):
    owner, reader, mid = shared_meeting
    theirs = folders(reader, "참고자료")
    reader.put(f"/api/meetings/{mid}/category", json={"category_id": theirs["id"]})

    # the owner's 미분류 still holds it: their own filing is what "none" reads
    assert mid in [m["id"] for m in listed(owner, category="none")]
    assert mid not in [m["id"] for m in listed(reader, category="none")]


# ------------------------------------------------ organisation is not access


def test_a_filing_left_behind_by_a_revoke_opens_nothing(shared_meeting, folders):
    """The row survives — it is the reader's, not the owner's, to remove — and it
    grants nothing. Every door is `access.READABLE` and only that."""
    owner, reader, mid = shared_meeting
    theirs = folders(reader, "보관")
    reader.put(f"/api/meetings/{mid}/category", json={"category_id": theirs["id"]})
    assert owner.delete(f"/api/meetings/{mid}/shares/{reader.account['id']}").status_code == 200

    assert reader.get(f"/api/meetings/{mid}").status_code == 404
    assert listed(reader, category=theirs["id"]) == []
    assert next(k for k in reader.get("/api/meeting-categories").json()["categories"]
                if k["id"] == theirs["id"])["meeting_count"] == 0


def test_filing_a_meeting_i_cannot_read_is_refused(client, login, make_meeting, folders):
    theirs_client = login()
    mid = make_meeting(f"{TAG} 남의 회의", LINES, owner=theirs_client.account["id"])
    mine = folders(client, "가져오기")

    assert client.put(f"/api/meetings/{mid}/category",
                      json={"category_id": mine["id"]}).status_code == 404
    assert client.put(f"/api/meetings/{mid}/alias", json={"alias": "훔친 이름"}).status_code == 404
    assert listed(client, category=mine["id"]) == []


def test_deleting_a_folder_keeps_the_meetings_the_alias_and_the_chats(
    client, make_meeting, folders,
):
    """The folder goes; nothing that was in it does."""
    mid = make_meeting(f"{TAG} 보관 회의", LINES)
    cat = client.post("/api/meeting-categories", json={"name": f"{TAG}-임시"}).json()
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": []}).json()["id"]
    client.put(f"/api/meetings/{mid}/category", json={"category_id": cat["id"]})
    client.put(f"/api/meetings/{mid}/alias", json={"alias": "보관본"})
    client.patch(f"/api/chat/sessions/{sid}/category", json={"category_id": cat["id"]})

    assert client.delete(f"/api/meeting-categories/{cat['id']}").status_code == 200

    row = client.get(f"/api/meetings/{mid}").json()["meeting"]
    assert row["category_id"] is None
    assert row["display_title"] == "보관본"        # the name survives the folder
    assert client.get(f"/api/chat/sessions/{sid}").json()["session"]["category_id"] is None
    client.delete(f"/api/chat/sessions/{sid}")


def test_a_folder_with_children_is_refused_rather_than_cascaded(client, folders):
    parent = folders(client, "상위")
    folders(client, "하위", parent_id=parent["id"])
    refused = client.delete(f"/api/meeting-categories/{parent['id']}")
    assert refused.status_code == 409
    assert "하위 카테고리 1개" in refused.json()["detail"]


# ------------------------------------------------------------------- chats


def test_a_chat_is_filed_in_the_same_tree_and_only_by_its_owner(client, login, folders):
    other = login()
    mine = folders(client, "정리")
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": []}).json()["id"]
    try:
        assert client.patch(f"/api/chat/sessions/{sid}/category",
                            json={"category_id": mine["id"]}).json()["category_id"] == mine["id"]
        assert next(k for k in tree(client).items() if k[1] == mine["id"])
        rows = client.get("/api/meeting-categories").json()["categories"]
        assert next(k["chat_count"] for k in rows if k["id"] == mine["id"]) == 1

        # somebody else's conversation is a 404, whatever the body says
        assert other.patch(f"/api/chat/sessions/{sid}/category",
                           json={"category_id": None}).status_code == 404
        assert other.patch(f"/api/chat/sessions/{sid}/title",
                           json={"title": "가로채기"}).status_code == 404
        assert other.delete(f"/api/chat/sessions/{sid}").status_code == 404

        # …and my own conversation cannot be filed in somebody else's folder
        theirs = folders(other, "남의 폴더")
        assert client.patch(f"/api/chat/sessions/{sid}/category",
                            json={"category_id": theirs["id"]}).status_code == 400

        assert client.patch(f"/api/chat/sessions/{sid}/category",
                            json={"category_id": None}).json()["category_id"] is None
    finally:
        client.delete(f"/api/chat/sessions/{sid}")


# ----------------------------------------------------------------- evidence


def test_a_source_is_titled_the_way_this_account_titles_the_meeting(shared_meeting):
    """An alias set today renames the evidence in yesterday's answer too, because
    it is applied when a source is read rather than when it is stored."""
    owner, reader, mid = shared_meeting
    sid = reader.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    try:
        first = reader.post(f"/api/chat/sessions/{sid}/messages",
                            json={"question": "정산 프로세스", "top_k": 12}).json()["sources"]
        # with no alias, the meeting's own name
        assert {s["meeting_title"] for s in first} == {f"{TAG} 8월 구매부 정산 회의"}

        reader.put(f"/api/meetings/{mid}/alias", json={"alias": "정산 사례"})
        stored = reader.get(f"/api/chat/sessions/{sid}").json()["messages"]
        shown = [s for m in stored for s in m["sources"]]
        assert shown and {s["meeting_title"] for s in shown} == {"정산 사례"}
        # the owner's own view of the same evidence is untouched
        assert owner.get(f"/api/meetings/{mid}").json()["meeting"]["display_title"] == \
            f"{TAG} 8월 구매부 정산 회의"
    finally:
        reader.delete(f"/api/chat/sessions/{sid}")
