"""Revising approved minutes without taking them out of search.

The promise being tested is narrow and absolute: from the moment v1 is published
until the moment v2 has finished indexing, every question is answered from v1 —
while v2 is being written, while v2 is being indexed, and forever after if v2's
indexing fails. There is no window where the meeting is unsearchable and no
window where a half-built index answers.

The other half is provenance. v1's transcript is not overwritten by v2, so an
answer given before a correction can still be taken back to the words it rested
on.
"""
import pytest
from conftest import requires_db

pytestmark = requires_db

TAG = "pytest-ver"
V1 = [
    ("SPEAKER_00", "배포 일정을 정리해 주세요."),
    ("SPEAKER_01", "금요일까지 처리하겠습니다."),
]
# The correction: a different day, in words the original does not contain, so a
# search can tell the two versions apart without matching on anything else.
V2_TEXT = "다음 주 월요일까지 처리하겠습니다."


@pytest.fixture
def approved(client, make_meeting):
    """A meeting with v1 published and searchable. -> meeting_id"""
    mid = make_meeting(f"{TAG} 배포 회의", V1)
    assert client.get(f"/api/meetings/{mid}/versions").json()["active_version"] == 1
    return mid


def ask(c, mid: int, question: str) -> list[dict]:
    sid = c.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    return c.post(f"/api/chat/sessions/{sid}/messages",
                  json={"question": question, "top_k": 12}).json()["sources"]


def evidence(c, mid: int, question: str) -> str:
    return "\n".join(s["text"] for s in ask(c, mid, question))


def edit(c, mid: int, sequence: int, text: str):
    return c.patch(f"/api/meetings/{mid}/transcript",
                   json={"segments": [{"sequence": sequence, "text": text}]})


# ---------------------------------------------------------------- starting one


def test_a_published_meeting_can_start_a_revision(client, approved):
    res = client.post(f"/api/meetings/{approved}/versions")
    assert res.status_code == 200
    assert res.json() == {"meeting_id": approved, "version": 2, "status": "DRAFT"}

    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 1
    assert [(v["version"], v["status"]) for v in body["versions"]] == [
        (2, "DRAFT"), (1, "PUBLISHED")
    ]


def test_a_new_revision_starts_as_a_copy_of_the_published_minutes(client, approved):
    client.post(f"/api/meetings/{approved}/versions")
    v1 = client.get(f"/api/meetings/{approved}/versions/1").json()["segments"]
    v2 = client.get(f"/api/meetings/{approved}/versions/2").json()["segments"]
    assert [(s["sequence"], s["text"], s["speaker_code"]) for s in v1] == \
           [(s["sequence"], s["text"], s["speaker_code"]) for s in v2]


def test_a_meeting_that_has_never_been_approved_cannot_be_revised(client, make_meeting):
    mid = make_meeting(f"{TAG} 초안", V1, status="REVIEW_REQUIRED")
    res = client.post(f"/api/meetings/{mid}/versions")
    assert res.status_code == 409
    assert "승인" in res.json()["detail"]


def test_only_one_revision_can_be_open_at_a_time(client, approved):
    assert client.post(f"/api/meetings/{approved}/versions").status_code == 200
    res = client.post(f"/api/meetings/{approved}/versions")
    assert res.status_code == 409
    assert "v2" in res.json()["detail"]
    assert len(client.get(f"/api/meetings/{approved}/versions").json()["versions"]) == 2


def test_the_owner_lands_on_the_draft_and_can_still_ask_for_the_published_one(
    client, approved
):
    client.post(f"/api/meetings/{approved}/versions")
    default = client.get(f"/api/meetings/{approved}").json()
    assert (default["version"], default["draft_version"], default["active_version"]) == (2, 2, 1)
    published = client.get(f"/api/meetings/{approved}", params={"version": 1}).json()
    assert published["version"] == 1
    assert client.get(f"/api/meetings/{approved}", params={"version": 9}).status_code == 404


# ------------------------------------------------------- editing, while v1 serves


def test_editing_the_draft_leaves_the_published_transcript_alone(client, approved):
    client.post(f"/api/meetings/{approved}/versions")
    assert edit(client, approved, 1, V2_TEXT).json() == {"updated": 1, "version": 2}

    v1 = client.get(f"/api/meetings/{approved}/versions/1").json()["segments"]
    v2 = client.get(f"/api/meetings/{approved}/versions/2").json()["segments"]
    assert v1[1]["text"] == V1[1][1]
    assert v2[1]["text"] == V2_TEXT


def test_search_keeps_answering_from_v1_while_v2_is_being_written(client, approved):
    """The requirement this whole design exists for."""
    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)

    found = evidence(client, approved, "언제까지 처리")
    assert "금요일" in found
    assert "월요일" not in found


def test_a_published_meeting_with_no_draft_refuses_an_edit(client, approved):
    res = edit(client, approved, 1, V2_TEXT)
    assert res.status_code == 409
    assert "회의록 수정" in res.json()["detail"]


def test_a_speaker_can_be_renamed_inside_a_draft_but_not_without_one(client, approved):
    speaker = client.get(f"/api/meetings/{approved}").json()["speakers"][0]["id"]
    url = f"/api/meetings/{approved}/speakers/{speaker}"
    assert client.patch(url, json={"display_name": "김대리"}).status_code == 409

    client.post(f"/api/meetings/{approved}/versions")
    assert client.patch(url, json={"display_name": "김대리"}).json()["display_name"] == "김대리"


def test_a_draft_can_be_thrown_away(client, approved):
    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)
    assert client.delete(f"/api/meetings/{approved}/versions/2").status_code == 200

    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 1
    assert [v["version"] for v in body["versions"]] == [1]
    assert "금요일" in evidence(client, approved, "언제까지 처리")


def test_version_one_can_never_be_thrown_away(client, approved):
    """It is the meeting's only minutes; discarding it would leave no transcript."""
    assert client.delete(f"/api/meetings/{approved}/versions/1").status_code == 409
    assert client.get(f"/api/meetings/{approved}/versions").json()["active_version"] == 1


# ------------------------------------------------------------------ publishing


def test_approving_a_revision_switches_the_index_to_it(client, approved):
    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)
    assert client.post(f"/api/meetings/{approved}/approve").json()["version"] == 2

    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 2
    assert {(v["version"], v["status"]) for v in body["versions"]} == {
        (1, "SUPERSEDED"), (2, "PUBLISHED")
    }
    found = evidence(client, approved, "언제까지 처리")
    assert "월요일" in found
    assert "금요일" not in found


def test_the_meeting_stays_completed_through_a_revision(client, approved):
    """The meeting status is v1's lifecycle and must not be borrowed for v2 —
    `m.status = 'COMPLETED'` is a retrieval predicate, so moving it would take v1
    out of search for the duration."""
    client.post(f"/api/meetings/{approved}/versions")
    assert client.get(f"/api/meetings/{approved}/status").json()["status"] == "COMPLETED"
    client.post(f"/api/meetings/{approved}/approve")
    assert client.get(f"/api/meetings/{approved}/status").json()["status"] == "COMPLETED"


def test_the_superseded_transcript_is_still_readable(client, approved):
    """Provenance. An answer given before the correction cited v1's words, and
    those words are still there to check it against."""
    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)
    client.post(f"/api/meetings/{approved}/approve")

    old = client.get(f"/api/meetings/{approved}/versions/1").json()
    assert old["status"] == "SUPERSEDED"
    assert old["segments"][1]["text"] == V1[1][1]


def test_a_source_says_which_version_it_came_from(client, approved):
    before = ask(client, approved, "언제까지 처리")
    assert {s["meeting_version"] for s in before} == {1}

    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)
    client.post(f"/api/meetings/{approved}/approve")

    after = ask(client, approved, "언제까지 처리")
    assert {s["meeting_version"] for s in after} == {2}


def test_publishing_leaves_no_chunk_behind_from_the_old_version(client, approved):
    from app.db import conn

    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)
    client.post(f"/api/meetings/{approved}/approve")
    with conn() as c:
        rows = c.execute(
            "SELECT DISTINCT version FROM chunks WHERE meeting_id = %s", (approved,)
        ).fetchall()
    assert [r["version"] for r in rows] == [2]


# -------------------------------------------------------------- failure safety


def test_a_failed_revision_indexing_leaves_the_published_version_serving(
    client, approved, monkeypatch
):
    """The one that must never regress.

    Embedding runs before the transaction that swaps the chunks, so a failure
    there cannot have deleted anything. v1 keeps its index, keeps answering, and
    the revision comes back as a draft the reviewer can retry.
    """
    from app.services import embedding

    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)

    def boom(texts):
        raise RuntimeError("임베딩 실패")

    # Restored by hand rather than with `monkeypatch.undo()`, which would also
    # undo conftest's autouse stand-in and send the rest of this test at the real
    # model.
    working = embedding.encode
    monkeypatch.setattr(embedding, "encode", boom)
    client.post(f"/api/meetings/{approved}/approve")
    monkeypatch.setattr(embedding, "encode", working)

    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 1
    assert {(v["version"], v["status"]) for v in body["versions"]} == {
        (1, "PUBLISHED"), (2, "DRAFT")
    }
    assert client.get(f"/api/meetings/{approved}/status").json()["status"] == "COMPLETED"
    found = evidence(client, approved, "언제까지 처리")
    assert "금요일" in found and "월요일" not in found

    # and the draft is still editable, so the reviewer can simply approve again
    assert edit(client, approved, 1, V2_TEXT).status_code == 200
    client.post(f"/api/meetings/{approved}/approve")
    assert client.get(f"/api/meetings/{approved}/versions").json()["active_version"] == 2


def test_a_first_indexing_failure_still_returns_to_the_review_gate(
    client, make_meeting, monkeypatch
):
    """Unchanged behaviour: with nothing published there is nothing to protect,
    so the meeting itself goes back for the reviewer to retry."""
    from app.services import embedding

    mid = make_meeting(f"{TAG} 첫 승인", V1, status="REVIEW_REQUIRED")
    working = embedding.encode
    monkeypatch.setattr(embedding, "encode", lambda texts: (_ for _ in ()).throw(RuntimeError("x")))
    client.post(f"/api/meetings/{mid}/approve")
    monkeypatch.setattr(embedding, "encode", working)

    status = client.get(f"/api/meetings/{mid}/status").json()
    assert status["status"] == "REVIEW_REQUIRED"
    assert "인덱싱 실패" in status["error_message"]
    body = client.get(f"/api/meetings/{mid}/versions").json()
    assert body["active_version"] is None
    assert body["versions"][0]["status"] == "DRAFT"


def test_a_reindex_of_the_published_version_keeps_publishing_it(client, approved):
    assert client.post(f"/api/meetings/{approved}/reindex").json()["version"] == 1
    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 1
    assert "금요일" in evidence(client, approved, "언제까지 처리")


def test_a_reindex_ignores_an_open_draft(client, approved):
    """Re-embedding is about the index, not the revision. A draft is unapproved
    and must not reach the index through a button that says 'rebuild'."""
    client.post(f"/api/meetings/{approved}/versions")
    edit(client, approved, 1, V2_TEXT)
    assert client.post(f"/api/meetings/{approved}/reindex").json()["version"] == 1
    assert "금요일" in evidence(client, approved, "언제까지 처리")
    assert client.get(f"/api/meetings/{approved}/versions").json()["active_version"] == 1


# ------------------------------------------------------------ sharing meets it


@pytest.fixture
def shared(client, login, approved, share):
    """v1 published and accepted by a second account. -> (other_client, mid)"""
    other = login()
    share(approved, other.account["id"])
    return other, approved


def test_a_reader_never_sees_an_unapproved_revision(client, shared):
    other, mid = shared
    client.post(f"/api/meetings/{mid}/versions")
    edit(client, mid, 1, V2_TEXT)

    detail = other.get(f"/api/meetings/{mid}").json()
    assert detail["version"] == 1
    assert detail["draft_version"] is None
    assert detail["segments"][1]["text"] == V1[1][1]
    # asking for it by number does not help either
    assert other.get(f"/api/meetings/{mid}", params={"version": 2}).json()["version"] == 1
    assert other.get(f"/api/meetings/{mid}/versions/2").status_code == 404
    assert "금요일" in evidence(other, mid, "언제까지 처리")


def test_a_reader_moves_to_the_new_version_without_being_invited_again(client, shared):
    """The share is on the meeting, not on a revision of it."""
    other, mid = shared
    client.post(f"/api/meetings/{mid}/versions")
    edit(client, mid, 1, V2_TEXT)
    client.post(f"/api/meetings/{mid}/approve")

    detail = other.get(f"/api/meetings/{mid}").json()
    assert detail["version"] == 2
    assert detail["segments"][1]["text"] == V2_TEXT
    assert "월요일" in evidence(other, mid, "언제까지 처리")
    # still exactly one share row, still ACCEPTED
    rows = client.get(f"/api/meetings/{mid}/shares").json()
    assert [r["status"] for r in rows] == ["ACCEPTED"]


def test_a_reader_sees_which_version_is_current_and_when_it_landed(client, shared):
    other, mid = shared
    client.post(f"/api/meetings/{mid}/versions")
    client.post(f"/api/meetings/{mid}/approve")
    row = next(m for m in other.get("/api/meetings", params={"q": TAG}).json()["items"]
               if m["id"] == mid)
    assert row["active_version"] == 2
    assert row["version_published_at"] is not None
