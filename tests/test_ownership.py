"""A meeting belongs to the account that uploaded it, and to nobody else.

The rule under test is one predicate — `access.READABLE` — so these tests are
mostly the same question asked at every door: the list, the detail page, the
transcript, the status, the summary, the facts, the versions, and each of the
four retrieval paths. A door that answers differently from the others is the
whole class of bug this file exists to catch.

Everything here uses two real accounts and goes through HTTP. The database is
shared, so nothing asserts an absolute count: each test narrows to meetings it
created itself.
"""
import pytest
from conftest import requires_db

pytestmark = requires_db

TAG = "pytest-own"
LINES = [("SPEAKER_00", "GPU 서버 도입은 9월입니다."), ("SPEAKER_01", "예산은 삼천만원입니다.")]

# Every request an account could make about a meeting it has no business seeing.
# Parametrized rather than written out, because the point is that the answer is
# the same at all of them: a meeting you may not read does not exist.
READS = [
    ("GET", "/api/meetings/{id}"),
    ("GET", "/api/meetings/{id}/status"),
    ("GET", "/api/meetings/{id}/summary"),
    ("GET", "/api/meetings/{id}/intelligence"),
    ("GET", "/api/meetings/{id}/versions"),
    ("GET", "/api/meetings/{id}/versions/1"),
    ("GET", "/api/meetings/{id}/shares"),
]
WRITES = [
    ("DELETE", "/api/meetings/{id}"),
    ("POST", "/api/meetings/{id}/approve"),
    ("POST", "/api/meetings/{id}/reindex"),
    ("PATCH", "/api/meetings/{id}/transcript"),
    ("PUT", "/api/meetings/{id}/held-at"),
    ("PUT", "/api/meetings/{id}/category"),
    ("PUT", "/api/meetings/{id}/me"),
    ("POST", "/api/meetings/{id}/summary"),
    ("POST", "/api/meetings/{id}/corrections"),
    ("POST", "/api/meetings/{id}/intelligence/rebuild"),
    ("POST", "/api/meetings/{id}/shares"),
    ("POST", "/api/meetings/{id}/versions"),
    ("DELETE", "/api/meetings/{id}/versions/2"),
    ("DELETE", "/api/meetings/{id}/shares/1"),
]


# Bodies for the endpoints that require one. Without them FastAPI answers 422
# before the handler runs — which is not a leak (it answers 422 for a real
# meeting too) but is not the refusal being tested either.
BODIES = {
    "/api/meetings/{id}/transcript": {"segments": []},
    "/api/meetings/{id}/shares": {"user_id": 1},
}


def call(c, method: str, url: str, meeting_id: int):
    body = BODIES.get(url, {}) if method in ("POST", "PUT", "PATCH") else None
    return c.request(method, url.format(id=meeting_id), json=body)


def titles(c, **params) -> list[str]:
    body = c.get("/api/meetings", params={"q": TAG, **params}).json()
    return [m["title"] for m in body["items"]]


# ------------------------------------------------------------------ ownership


def test_an_upload_belongs_to_the_account_that_made_it(client, monkeypatch, tmp_path):
    """The owner comes from the session. There is no field to send instead."""
    from app import config
    from app.api import meetings as api

    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path)
    # The audio phase is not what this is about, and it would try to run ffmpeg.
    monkeypatch.setattr(api.pipeline, "process", lambda *a, **k: None)

    res = client.post(
        "/api/meetings",
        files={"file": ("a.wav", b"RIFF0000WAVE", "audio/wav")},
        # An owner in the body is not a field; FastAPI ignores it and the server
        # uses the session either way.
        data={"title": f"{TAG} 업로드", "owner_user_id": "1"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["owner_user_id"] == client.account["id"]

    detail = client.get(f"/api/meetings/{res.json()['id']}").json()
    assert detail["role"] == "OWNER"
    client.delete(f"/api/meetings/{res.json()['id']}")


def test_an_upload_opens_version_one_as_a_draft(client, make_meeting):
    mid = make_meeting(f"{TAG} v1", LINES, status="REVIEW_REQUIRED")
    body = client.get(f"/api/meetings/{mid}/versions").json()
    assert body["active_version"] is None
    assert [(v["version"], v["status"]) for v in body["versions"]] == [(1, "DRAFT")]


def test_approval_publishes_version_one(client, make_meeting):
    mid = make_meeting(f"{TAG} 승인", LINES)  # the fixture approves it
    body = client.get(f"/api/meetings/{mid}/versions").json()
    assert body["active_version"] == 1
    assert body["versions"][0]["status"] == "PUBLISHED"
    assert body["versions"][0]["published_at"] is not None


# --------------------------------------------------------------- isolation


def test_another_accounts_meeting_is_not_on_my_list(client, login, make_meeting):
    make_meeting(f"{TAG} 남의 회의", LINES)
    theirs = login()
    assert titles(theirs) == []
    assert theirs.get("/api/meetings", params={"q": TAG}).json()["total"] == 0


def test_the_total_and_the_page_describe_the_same_owned_set(client, login, make_meeting):
    """A count that includes meetings the rows cannot show is a leak on its own —
    it says how much somebody else has."""
    for i in range(3):
        make_meeting(f"{TAG} 내 {i}", LINES, held_ago=i + 1)
    theirs = login()
    mine_body = client.get("/api/meetings", params={"q": TAG}).json()
    their_body = theirs.get("/api/meetings", params={"q": TAG}).json()
    assert mine_body["total"] == len(mine_body["items"]) == 3
    assert their_body["total"] == len(their_body["items"]) == 0


@pytest.mark.parametrize("method, url", READS + WRITES)
def test_every_endpoint_refuses_another_accounts_meeting(
    client, login, make_meeting, method, url
):
    """404, not 403: an id somebody else owns must be indistinguishable from one
    that was never issued, or the id space itself becomes an oracle."""
    mid = make_meeting(f"{TAG} 비공개", LINES)
    theirs = login()
    assert call(theirs, method, url, mid).status_code == 404


@pytest.mark.parametrize("method, url", READS + WRITES)
def test_an_id_that_does_not_exist_answers_exactly_the_same(client, method, url):
    assert call(client, method, url, 999_999_999).status_code == 404


def test_an_orphaned_meeting_is_readable_by_nobody(client, login, make_meeting):
    """A meeting from before migration 009 whose uploader could not be proven.

    The predicate is a plain equality against a NULL column, so it matches no
    account at all. The failure direction matters: an orphan is invisible, never
    public.
    """
    mid = make_meeting(f"{TAG} 고아", LINES, owner=None)
    other = login()
    for c in (client, other):
        assert c.get(f"/api/meetings/{mid}").status_code == 404
        assert titles(c) == []


def test_the_owner_can_do_everything_with_their_own_meeting(client, make_meeting):
    mid = make_meeting(f"{TAG} 내 것", LINES)
    assert client.get(f"/api/meetings/{mid}").json()["role"] == "OWNER"
    assert client.put(f"/api/meetings/{mid}/held-at",
                      json={"held_at": "2026-08-01T09:00:00+09:00"}).status_code == 200
    assert client.put(f"/api/meetings/{mid}/category", json={"category_id": None}).status_code == 200
    assert client.post(f"/api/meetings/{mid}/versions").status_code == 200
    assert client.delete(f"/api/meetings/{mid}").status_code == 200


# ----------------------------------------------------------------- retrieval


def _sources(c, question: str, scope=None) -> list[dict]:
    sid = c.post("/api/chat/sessions", json={"scope_meeting_ids": scope or []}).json()["id"]
    return c.post(f"/api/chat/sessions/{sid}/messages",
                  json={"question": question, "top_k": 12}).json()["sources"]


def test_retrieval_never_reaches_another_accounts_meeting(client, login, make_meeting):
    mine = make_meeting(f"{TAG} 내 GPU", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    theirs_client = login()
    theirs = make_meeting(f"{TAG} 남의 GPU", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")],
                          owner=theirs_client.account["id"])

    assert {s["meeting_id"] for s in _sources(client, "GPU 서버")} <= {mine}
    assert {s["meeting_id"] for s in _sources(theirs_client, "GPU 서버")} <= {theirs}


def test_a_scope_naming_another_accounts_meeting_is_narrowed_away(
    client, login, make_meeting
):
    """Injection through the one field that names meeting ids.

    The scope is stored server-side, so the attack is to PATCH it. What comes
    back is the intersection, and the search that follows finds nothing from the
    meeting that was injected.
    """
    theirs_client = login()
    theirs = make_meeting(f"{TAG} 남의 예산", [("SPEAKER_00", "예산은 삼천만원입니다.")],
                          owner=theirs_client.account["id"])
    mine = make_meeting(f"{TAG} 내 예산", [("SPEAKER_00", "예산은 오천만원입니다.")])

    sid = client.post("/api/chat/sessions",
                      json={"scope_meeting_ids": [mine, theirs]}).json()["id"]
    stored = client.get(f"/api/chat/sessions/{sid}").json()["session"]["scope_meeting_ids"]
    assert stored == [mine]

    patched = client.patch(f"/api/chat/sessions/{sid}",
                           json={"scope_meeting_ids": [theirs]}).json()
    assert patched["scope_meeting_ids"] == []

    body = client.post(f"/api/chat/sessions/{sid}/messages",
                       json={"question": "예산", "top_k": 12}).json()
    assert {s["meeting_id"] for s in body["sources"]} <= {mine}


def test_all_four_retrieval_paths_share_the_access_scope(client, login, make_meeting):
    """Dense chunk, lexical chunk, dense fact, lexical fact.

    Called directly rather than through chat, because a path that forgot the
    predicate would still be hidden by the chat scope. Each is asked for the
    other account's meeting explicitly and must return nothing.
    """
    from app.services import intelligence, rag

    theirs_client = login()
    theirs = make_meeting(f"{TAG} 남의 인증서", [("SPEAKER_00", "SSL 인증서를 발급합니다.")],
                          owner=theirs_client.account["id"])
    me = client.account["id"]

    scope = [theirs]
    assert rag.search_dense("SSL 인증서", scope, user_id=me) == []
    assert rag.search_lexical("SSL 인증서", scope, user_id=me) == []
    assert intelligence.search_dense("SSL 인증서", scope, user_id=me) == []
    assert intelligence.search_lexical("SSL 인증서", scope, user_id=me) == []

    # …and the owner really can reach it, so the emptiness above is the predicate
    # and not a broken fixture.
    theirs_id = theirs_client.account["id"]
    assert rag.search_dense("SSL 인증서", scope, user_id=theirs_id)


def test_a_category_count_only_counts_meetings_i_can_see(client, login, make_meeting):
    """The sidebar number used to describe the whole database."""
    name = f"{TAG}-cat"
    cat = client.post("/api/meeting-categories", json={"name": name}).json()
    try:
        theirs_client = login()
        mid = make_meeting(f"{TAG} 남의 분류", LINES, owner=theirs_client.account["id"])
        assert client.put(f"/api/meetings/{mid}/category",
                          json={"category_id": cat["id"]}).status_code == 404
        # file it as its real owner
        theirs_client.put(f"/api/meetings/{mid}/category", json={"category_id": cat["id"]})

        def count(c):
            return next(k["meeting_count"] for k in c.get("/api/meeting-categories").json()
                        if k["id"] == cat["id"])

        assert count(theirs_client) == 1
        assert count(client) == 0
    finally:
        client.delete(f"/api/meeting-categories/{cat['id']}")
