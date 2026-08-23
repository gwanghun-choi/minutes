"""Approved minutes are immutable.

This is the product's central promise about a meeting, and it is a promise about
the *server*: hiding a button is presentation, so every test here goes at the API
the way a script would.

Correcting is something that happens before approval. Once a person has said
these minutes are correct, the transcript is what every chunk, every fact, every
stored citation, and every shared reader's answer rests on, and nothing in the
product rewrites it — there is no revision to start, none to approve, and none to
throw away.

What is kept is provenance. `meeting_versions` and the per-version transcript are
still readable, because a database that ran an earlier build may hold a second
revision and an answer given at the time cites the words published then.
"""
import pytest
from conftest import requires_db

pytestmark = requires_db

TAG = "pytest-ver"
LINES = [
    ("SPEAKER_00", "배포 일정을 정리해 주세요."),
    ("SPEAKER_01", "금요일까지 처리하겠습니다."),
]
CORRECTED = "다음 주 월요일까지 처리하겠습니다."


@pytest.fixture
def approved(client, make_meeting):
    """A meeting with v1 published and searchable. -> meeting_id"""
    mid = make_meeting(f"{TAG} 배포 회의", LINES)
    assert client.get(f"/api/meetings/{mid}/versions").json()["active_version"] == 1
    return mid


@pytest.fixture
def reviewing(client, make_meeting):
    """A meeting still at the review gate, where correcting is the whole job."""
    return make_meeting(f"{TAG} 검토 대기", LINES, status="REVIEW_REQUIRED")


def ask(c, mid: int, question: str) -> str:
    sid = c.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    body = c.post(f"/api/chat/sessions/{sid}/messages",
                  json={"question": question, "top_k": 12}).json()
    return "\n".join(s["text"] for s in body["sources"])


def transcript(c, mid: int, version: int | None = None) -> list[str]:
    url = f"/api/meetings/{mid}" + (f"?version={version}" if version else "")
    return [s["text"] for s in c.get(url).json()["segments"]]


# ------------------------------------------------------- before the approval


def test_the_reviewer_corrects_the_draft_and_approves_it(client, reviewing):
    """The one editing window the product has, end to end."""
    detail = client.get(f"/api/meetings/{reviewing}").json()
    assert detail["draft_version"] == 1
    assert detail["version"] == 1
    assert detail["active_version"] is None

    saved = client.patch(f"/api/meetings/{reviewing}/transcript",
                         json={"segments": [{"sequence": 1, "text": CORRECTED}]})
    assert saved.status_code == 200
    assert saved.json() == {"updated": 1, "version": 1}
    assert CORRECTED in transcript(client, reviewing)

    assert client.post(f"/api/meetings/{reviewing}/approve").status_code == 200
    after = client.get(f"/api/meetings/{reviewing}").json()
    assert after["meeting"]["status"] == "COMPLETED"
    assert after["active_version"] == 1
    assert after["draft_version"] is None


def test_a_speaker_can_be_renamed_before_approval_and_not_after(client, reviewing):
    speaker = client.get(f"/api/meetings/{reviewing}").json()["speakers"][0]
    assert client.patch(f"/api/meetings/{reviewing}/speakers/{speaker['id']}",
                        json={"display_name": "김개발"}).status_code == 200
    client.post(f"/api/meetings/{reviewing}/approve")
    refused = client.patch(f"/api/meetings/{reviewing}/speakers/{speaker['id']}",
                           json={"display_name": "박기획"})
    assert refused.status_code == 409
    assert "승인된 회의록은 수정할 수 없습니다." in refused.json()["detail"]
    assert client.get(f"/api/meetings/{reviewing}").json()["speakers"][0]["display_name"] == "김개발"


# -------------------------------------------------------- after the approval


MUTATIONS = [
    ("PATCH", "/transcript", {"segments": [{"sequence": 0, "text": "고쳐진 문장"}]}),
    ("POST", "/approve", {}),
    ("POST", "/corrections", {}),
]


@pytest.mark.parametrize("method,path,body", MUTATIONS)
def test_an_approved_meeting_refuses_every_transcript_mutation(
    client, approved, method, path, body,
):
    """The server refuses, whatever the browser drew."""
    response = client.request(method, f"/api/meetings/{approved}{path}", json=body)
    assert response.status_code == 409, response.text
    assert "승인된 회의록은 수정할 수 없습니다." in response.json()["detail"]
    assert transcript(client, approved) == [t for _, t in LINES]


def test_there_is_no_endpoint_that_starts_a_revision(client, approved):
    """Not 403, not 409 — the action does not exist."""
    assert client.post(f"/api/meetings/{approved}/versions").status_code == 405
    assert client.delete(f"/api/meetings/{approved}/versions/1").status_code == 405
    assert client.delete(f"/api/meetings/{approved}/versions/2").status_code == 405


def test_an_approved_meeting_never_reports_an_editable_draft(client, approved):
    detail = client.get(f"/api/meetings/{approved}").json()
    assert detail["draft_version"] is None
    assert detail["active_version"] == 1
    assert detail["version"] == 1
    assert detail["role"] == "OWNER"


def test_the_published_transcript_is_what_search_keeps_answering_from(client, approved):
    """The refusal is not cosmetic: the evidence never moves."""
    before = ask(client, approved, "언제까지 처리하나요?")
    client.patch(f"/api/meetings/{approved}/transcript",
                 json={"segments": [{"sequence": 1, "text": CORRECTED}]})
    assert CORRECTED not in ask(client, approved, "언제까지 처리하나요?")
    assert ask(client, approved, "언제까지 처리하나요?") == before


def test_a_shared_reader_cannot_edit_an_approved_meeting_either(client, approved, login, share):
    other = login()
    share(approved, other.account["id"])
    refused = other.patch(f"/api/meetings/{approved}/transcript",
                          json={"segments": [{"sequence": 0, "text": "고쳐진 문장"}]})
    assert refused.status_code == 403
    assert transcript(other, approved) == [t for _, t in LINES]


# ------------------------------------------------------------ what is kept


def test_the_version_history_is_still_readable(client, approved):
    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 1
    assert [(v["version"], v["status"]) for v in body["versions"]] == [(1, "PUBLISHED")]
    assert body["versions"][0]["published_at"] is not None
    assert body["versions"][0]["segment_count"] == len(LINES)


def test_a_source_says_which_version_it_came_from(client, approved):
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [approved]}).json()["id"]
    sources = client.post(f"/api/chat/sessions/{sid}/messages",
                          json={"question": "배포 일정", "top_k": 12}).json()["sources"]
    assert sources
    assert {s["meeting_version"] for s in sources} == {1}


def test_a_second_revision_left_by_an_earlier_build_is_readable_but_frozen(
    client, approved, legacy_revision,
):
    """A database that ran the build with 회의록 수정 in it.

    v2 exists and is published; v1 is superseded. Both transcripts are readable —
    that is the provenance the version table is kept for — and neither can be
    written to, because the meeting is COMPLETED.
    """
    legacy_revision(approved, [CORRECTED, "추가된 발화"])
    body = client.get(f"/api/meetings/{approved}/versions").json()
    assert body["active_version"] == 2
    assert {(v["version"], v["status"]) for v in body["versions"]} == {
        (1, "SUPERSEDED"), (2, "PUBLISHED"),
    }
    assert transcript(client, approved, 1) == [t for _, t in LINES]
    assert transcript(client, approved, 2) == [CORRECTED, "추가된 발화"]
    assert client.get(f"/api/meetings/{approved}").json()["draft_version"] is None
    assert client.patch(f"/api/meetings/{approved}/transcript",
                        json={"segments": [{"sequence": 0, "text": "x"}]}).status_code == 409


def test_a_stranded_draft_from_an_earlier_build_cannot_be_edited_or_approved(
    client, approved, legacy_revision,
):
    """The other thing an earlier build could leave behind: an unfinished draft.

    It stays in the table — migrations here only add — and the meeting reports no
    editable revision, so neither the screen nor a direct request can resume it.
    """
    legacy_revision(approved, ["초안 문장"], status="DRAFT")
    assert client.get(f"/api/meetings/{approved}").json()["draft_version"] is None
    assert client.patch(f"/api/meetings/{approved}/transcript",
                        json={"segments": [{"sequence": 0, "text": "x"}]}).status_code == 409
    assert client.post(f"/api/meetings/{approved}/approve").status_code == 409
    assert client.get(f"/api/meetings/{approved}/versions").json()["active_version"] == 1
