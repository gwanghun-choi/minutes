"""Sharing a meeting: invite, accept or refuse, and take it back.

The whole flow through HTTP with two real accounts, because that is the only way
to test the thing that matters — not that a row was written, but that access
appears and disappears with it, at every door at once.

Two ideas are kept apart on purpose and each has its own tests here:

* Being *given* a meeting is not being *in* it. A shared reader with no speaker
  mapping still gets `NO_IDENTITY` for "내가 요청한 것", exactly as they would in
  a meeting they own.
* Being able to *read* a meeting is not being able to *change* it. There is no
  permission level between OWNER and SHARED_READ, so there is nothing to
  mis-configure.
"""
import pytest
from conftest import requires_db

pytestmark = requires_db

TAG = "pytest-share"
LINES = [
    ("SPEAKER_00", "SSL 인증서 발급을 부탁드립니다."),
    ("SPEAKER_01", "네, 금요일까지 발급하겠습니다."),
]

# Everything a shared reader must not be able to do — every write that touches
# the canonical meeting. The message differs; the refusal does not.
#
# What is deliberately *not* here: the personal filing endpoints (`/category`,
# `/alias`). Those write `user_meeting_filing`, one row per (account, meeting),
# and a shared reader arranging their own screen changes nothing anybody else
# sees. See `test_a_shared_reader_files_and_renames_only_their_own_copy`.
FORBIDDEN = [
    ("DELETE", "/api/meetings/{id}", None),
    ("POST", "/api/meetings/{id}/approve", {}),
    ("POST", "/api/meetings/{id}/reindex", {}),
    ("PATCH", "/api/meetings/{id}/transcript", {"segments": []}),
    ("PUT", "/api/meetings/{id}/held-at", {"held_at": None}),
    ("POST", "/api/meetings/{id}/summary", {}),
    ("POST", "/api/meetings/{id}/corrections", {}),
    ("POST", "/api/meetings/{id}/intelligence/rebuild", {}),
    ("GET", "/api/meetings/{id}/shares", None),
    ("POST", "/api/meetings/{id}/shares", {"user_id": 1}),
    ("DELETE", "/api/meetings/{id}/shares/1", None),
]


@pytest.fixture
def pair(client, login, make_meeting):
    """An owner with one approved meeting, and a second account to invite.

    -> (owner_client, other_client, meeting_id). Nothing is shared yet; each test
    drives the invitation itself, because the flow is what is being tested.
    """
    mid = make_meeting(f"{TAG} 인프라 회의", LINES)
    return client, login(), mid


def invite(owner, mid: int, user_id: int):
    return owner.post(f"/api/meetings/{mid}/shares", json={"user_id": user_id})


def inbox(c) -> list[dict]:
    return c.get("/api/share-invitations").json()


def visible(c, mid: int, **params) -> bool:
    body = c.get("/api/meetings", params={"q": TAG, **params}).json()
    return mid in {m["id"] for m in body["items"]}


# ------------------------------------------------------------------- invite


def test_only_an_approved_meeting_can_be_shared(client, login, make_meeting):
    """A draft is unreviewed AI output. Handing it over would publish a
    transcript nobody has checked, under the same UI as approved minutes."""
    other = login()
    draft = make_meeting(f"{TAG} 초안", LINES, status="REVIEW_REQUIRED")
    res = invite(client, draft, other.account["id"])
    assert res.status_code == 409
    assert "승인" in res.json()["detail"]
    assert inbox(other) == []


def test_inviting_yourself_is_refused_by_the_database(pair):
    owner, _, mid = pair
    res = invite(owner, mid, owner.account["id"])
    assert res.status_code == 400


def test_inviting_an_account_that_does_not_exist_is_refused(pair):
    owner, _, mid = pair
    assert invite(owner, mid, 999_999_999).status_code == 400


def test_a_second_pending_invitation_is_refused(pair):
    owner, other, mid = pair
    assert invite(owner, mid, other.account["id"]).status_code == 200
    assert invite(owner, mid, other.account["id"]).status_code == 409
    assert len(inbox(other)) == 1


def test_reinviting_someone_who_already_accepted_is_refused(pair):
    owner, other, mid = pair
    share_id = invite(owner, mid, other.account["id"]).json()["id"]
    other.post(f"/api/share-invitations/{share_id}/accept")
    res = invite(owner, mid, other.account["id"])
    assert res.status_code == 409
    assert "이미 공유" in res.json()["detail"]


def test_the_invitation_stores_an_account_id_and_not_a_name(pair):
    owner, other, mid = pair
    invite(owner, mid, other.account["id"])
    rows = owner.get(f"/api/meetings/{mid}/shares").json()
    assert [(r["invited_user_id"], r["status"]) for r in rows] == [
        (other.account["id"], "PENDING")
    ]
    # the name is shown, but it is resolved from users at read time
    assert rows[0]["display_name"] == other.account["display_name"]


# -------------------------------------------------------------- before accept


def test_a_pending_invitation_grants_nothing(pair):
    """PENDING is an offer, not a permission. Everything stays 404 until the
    invited person says yes."""
    owner, other, mid = pair
    invite(owner, mid, other.account["id"])

    assert not visible(other, mid)
    assert other.get(f"/api/meetings/{mid}").status_code == 404
    assert other.get(f"/api/meetings/{mid}/status").status_code == 404
    assert other.get(f"/api/meetings/{mid}/intelligence").status_code == 404
    # …but the invitation itself is visible to them, with enough to decide on
    invitation = inbox(other)[0]
    assert invitation["meeting_id"] == mid
    assert invitation["shared_by"] == owner.account["display_name"]


def test_a_refused_invitation_grants_nothing_and_leaves_the_inbox(pair):
    owner, other, mid = pair
    share_id = invite(owner, mid, other.account["id"]).json()["id"]
    assert other.post(f"/api/share-invitations/{share_id}/reject").json()["status"] == "REJECTED"

    assert inbox(other) == []
    assert other.get(f"/api/meetings/{mid}").status_code == 404
    assert not visible(other, mid)
    assert owner.get(f"/api/meetings/{mid}/shares").json()[0]["status"] == "REJECTED"


def test_a_refusal_can_be_followed_by_a_fresh_invitation(pair):
    """One row per (meeting, account), reopened — not a second row racing it."""
    owner, other, mid = pair
    share_id = invite(owner, mid, other.account["id"]).json()["id"]
    other.post(f"/api/share-invitations/{share_id}/reject")

    again = invite(owner, mid, other.account["id"])
    assert again.status_code == 200
    assert len(owner.get(f"/api/meetings/{mid}/shares").json()) == 1
    assert len(inbox(other)) == 1


def test_only_the_invited_account_can_answer_an_invitation(pair, login):
    owner, other, mid = pair
    share_id = invite(owner, mid, other.account["id"]).json()["id"]
    stranger = login()
    assert stranger.post(f"/api/share-invitations/{share_id}/accept").status_code == 404
    assert owner.post(f"/api/share-invitations/{share_id}/accept").status_code == 404
    assert inbox(other)[0]["id"] == share_id


# --------------------------------------------------------------- after accept


@pytest.fixture
def shared(pair):
    """-> (owner, other, meeting_id) with the invitation accepted through the API."""
    owner, other, mid = pair
    share_id = invite(owner, mid, other.account["id"]).json()["id"]
    assert other.post(f"/api/share-invitations/{share_id}/accept").json()["status"] == "ACCEPTED"
    return owner, other, mid


def test_an_accepted_share_can_read_the_meeting_and_its_transcript(shared):
    owner, other, mid = shared
    detail = other.get(f"/api/meetings/{mid}").json()
    assert detail["role"] == "SHARED_READ"
    assert [s["text"] for s in detail["segments"]] == [t for _, t in LINES]
    assert detail["meeting"]["owner_display_name"] == owner.account["display_name"]
    # the sharing panel is the owner's alone, and so is even its count
    assert detail["shared_with"] is None
    assert other.get(f"/api/meetings/{mid}/intelligence").status_code == 200
    assert other.get(f"/api/meetings/{mid}/versions").status_code == 200


def test_a_shared_reader_files_and_renames_only_their_own_copy(shared):
    """The whole point of migration 011, in one test.

    The reader gives the meeting their own folder and their own name. The owner's
    screen does not move, and `meetings.title` — the recording's canonical name —
    is what it always was.
    """
    owner, other, mid = shared
    canonical = owner.get(f"/api/meetings/{mid}").json()["meeting"]["title"]
    cat = other.post("/api/meeting-categories", json={"name": f"{TAG}-면접준비"}).json()
    try:
        assert other.put(f"/api/meetings/{mid}/category",
                         json={"category_id": cat["id"]}).status_code == 200
        assert other.put(f"/api/meetings/{mid}/alias",
                         json={"alias": "정산 프로세스 사례"}).status_code == 200

        theirs = other.get(f"/api/meetings/{mid}").json()["meeting"]
        assert theirs["display_title"] == "정산 프로세스 사례"
        assert theirs["title"] == canonical          # canonical, untouched
        assert theirs["category_id"] == cat["id"]

        mine = owner.get(f"/api/meetings/{mid}").json()["meeting"]
        assert mine["title"] == canonical
        assert mine["display_title"] == canonical    # no alias of my own
        assert mine["category_id"] is None           # their folder is not mine
        assert cat["id"] not in [k["id"] for k in owner.get("/api/meeting-categories").json()]
    finally:
        other.delete(f"/api/meeting-categories/{cat['id']}")


def test_an_accepted_share_appears_only_under_the_shared_scope(shared):
    owner, other, mid = shared
    assert visible(other, mid)
    assert visible(other, mid, scope="shared")
    assert not visible(other, mid, scope="mine")
    # and the other way round for the owner
    assert visible(owner, mid, scope="mine")
    assert not visible(owner, mid, scope="shared")


def test_a_shared_row_says_who_shared_it(shared):
    owner, other, mid = shared
    row = next(m for m in other.get("/api/meetings", params={"q": TAG}).json()["items"]
               if m["id"] == mid)
    assert row["is_owner"] is False
    assert row["owner_display_name"] == owner.account["display_name"]


def test_a_shared_meeting_is_searchable_by_the_reader(shared):
    owner, other, mid = shared
    sid = other.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    body = other.post(f"/api/chat/sessions/{sid}/messages",
                      json={"question": "SSL 인증서", "top_k": 12}).json()
    assert {s["meeting_id"] for s in body["sources"]} == {mid}


@pytest.mark.parametrize("method, url, body", FORBIDDEN)
def test_a_shared_reader_cannot_change_anything(shared, method, url, body):
    """403 rather than 404: they already know the meeting exists, so the honest
    answer is that reading it is not permission to change it."""
    _, other, mid = shared
    res = other.request(method, url.format(id=mid), json=body)
    assert res.status_code == 403, f"{method} {url} -> {res.status_code}"


def test_a_shared_reader_cannot_re_share(shared, login):
    """The only account that can hand a meeting on is the one that owns it."""
    _, other, mid = shared
    third = login()
    assert invite(other, mid, third.account["id"]).status_code == 403
    assert inbox(third) == []


# --------------------------------------------------------------------- revoke


def test_revoking_removes_access_everywhere_at_once(shared):
    owner, other, mid = shared
    assert owner.delete(f"/api/meetings/{mid}/shares/{other.account['id']}").status_code == 200

    assert not visible(other, mid)
    assert other.get(f"/api/meetings/{mid}").status_code == 404
    assert other.get(f"/api/meetings/{mid}/status").status_code == 404
    assert other.get(f"/api/meetings/{mid}/intelligence").status_code == 404
    assert other.get(f"/api/meetings/{mid}/versions").status_code == 404
    # …including the personal filing endpoints: a filing row is not access
    assert other.put(f"/api/meetings/{mid}/category",
                     json={"category_id": None}).status_code == 404
    assert other.put(f"/api/meetings/{mid}/alias", json={"alias": "x"}).status_code == 404
    # and the id still cannot be injected back in through a chat scope
    sid = other.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    assert other.get(f"/api/chat/sessions/{sid}").json()["session"]["scope_meeting_ids"] == []


def test_revoking_is_recorded_rather_than_deleted(shared):
    owner, other, mid = shared
    owner.delete(f"/api/meetings/{mid}/shares/{other.account['id']}")
    row = owner.get(f"/api/meetings/{mid}/shares").json()[0]
    assert row["status"] == "REVOKED"
    assert row["revoked_at"] is not None
    assert row["responded_at"] is not None  # the acceptance is still on the record


def test_a_revoked_reader_stops_retrieving_from_the_meeting(shared):
    """The scope was chosen while the share was live. New questions must not
    still answer from it."""
    owner, other, mid = shared
    sid = other.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    first = other.post(f"/api/chat/sessions/{sid}/messages",
                       json={"question": "SSL 인증서", "top_k": 12}).json()
    assert first["sources"]

    owner.delete(f"/api/meetings/{mid}/shares/{other.account['id']}")

    after = other.post(f"/api/chat/sessions/{sid}/messages",
                       json={"question": "SSL 인증서", "top_k": 12}).json()
    assert after["sources"] == []
    # and it does not silently widen to the whole corpus instead
    assert "접근할 수 없습니다" in after["answer"]


def test_a_revoked_reader_can_no_longer_read_the_stored_evidence(shared):
    """`chat_messages.sources` is a snapshot of the transcript words. Left alone
    it would keep the minutes readable in a chat history forever."""
    owner, other, mid = shared
    sid = other.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    other.post(f"/api/chat/sessions/{sid}/messages", json={"question": "SSL 인증서"})
    before = other.get(f"/api/chat/sessions/{sid}").json()["messages"]
    assert any(s["text"] for m in before for s in m["sources"])

    owner.delete(f"/api/meetings/{mid}/shares/{other.account['id']}")

    after = other.get(f"/api/chat/sessions/{sid}").json()["messages"]
    stored = [s for m in after for s in m["sources"]]
    assert stored, "the message keeps its citations"
    for s in stored:
        assert s["revoked"] is True
        assert s["text"] == ""
        assert s["meeting_id"] is None
        assert "SSL" not in s["meeting_title"]


def test_deleting_a_shared_meeting_removes_it_for_the_reader_too(shared):
    owner, other, mid = shared
    assert owner.delete(f"/api/meetings/{mid}").status_code == 200
    assert other.get(f"/api/meetings/{mid}").status_code == 404
    assert not visible(other, mid)


# ------------------------------------------------------- shared != participant


def test_being_shared_a_meeting_does_not_make_you_a_speaker_in_it(shared):
    """The question this whole separation exists for.

    B was given A's meeting. B was not in it. Asking "내가 요청한 것" must not
    guess that B is one of the two people who were.
    """
    from app.services import rag

    _, other, mid = shared
    sid = other.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    body = other.post(f"/api/chat/sessions/{sid}/messages",
                      json={"question": "내가 요청한 게 뭐야?"}).json()
    assert body["answer"] == rag.NO_IDENTITY
    assert body["sources"] == []


def test_a_shared_reader_who_maps_themselves_gets_self_reference_back(shared):
    """Mapping is explicit and per meeting, and a shared reader may do it — that
    is what separates "I was in this meeting" from "somebody sent it to me"."""
    _, other, mid = shared
    detail = other.get(f"/api/meetings/{mid}").json()
    speaker = detail["speakers"][0]["id"]
    assert other.put(f"/api/meetings/{mid}/me", json={"speaker_id": speaker}).status_code == 200

    sid = other.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    body = other.post(f"/api/chat/sessions/{sid}/messages",
                      json={"question": "내가 요청한 게 뭐야?"}).json()
    assert "나로 지정" not in body["answer"]


def test_the_owners_mapping_is_not_the_readers(shared):
    owner, other, mid = shared
    speakers = owner.get(f"/api/meetings/{mid}").json()["speakers"]
    owner.put(f"/api/meetings/{mid}/me", json={"speaker_id": speakers[0]["id"]})
    assert other.get(f"/api/meetings/{mid}").json()["my_speaker_id"] is None


# ------------------------------------------------------------- user search


def test_user_search_needs_a_term_and_never_returns_the_caller(client, login):
    other = login()
    assert client.get("/api/users", params={"q": ""}).json() == []
    found = client.get("/api/users", params={"q": other.account["username"]}).json()
    assert [u["id"] for u in found] == [other.account["id"]]
    assert client.account["id"] not in {u["id"] for u in found}
    assert "password_hash" not in found[0]


def test_user_search_marks_who_is_already_invited(pair):
    owner, other, mid = pair
    invite(owner, mid, other.account["id"])
    found = owner.get("/api/users",
                      params={"q": other.account["username"], "meeting_id": mid}).json()
    assert found[0]["share_status"] == "PENDING"


def test_user_search_will_not_answer_who_has_someone_elses_meeting(pair, login):
    """`meeting_id` is a convenience for the invite dialog, so it is checked for
    ownership — otherwise it answers "who has meeting 42" for any guessed id."""
    _, other, mid = pair
    stranger = login()
    assert stranger.get("/api/users",
                        params={"q": "pytest", "meeting_id": mid}).status_code == 404
