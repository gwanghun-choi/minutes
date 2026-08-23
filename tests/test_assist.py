"""Meeting summary and AI transcript correction.

Both call OpenAI over the whole transcript and neither may write to it. The
correction path in particular must stay a suggestion: the reviewer applies it in
the browser and saves through the existing PATCH, so approval keeps its meaning.
"""
import json

import pytest
from conftest import requires_db

from app.db import conn
from app.services import assist, pipeline

pytestmark = requires_db


@pytest.fixture
def meeting(client):
    """A meeting at the review gate with a three-line draft transcript.

    Owned by the account `client` is logged in as, because that is what an upload
    produces — an unowned meeting is an orphan nobody may read, and every request
    below would be a 404 about permission rather than about what it is testing.
    """
    from app.services import versions

    with conn() as c:
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status,"
            " owner_user_id) VALUES ('pytest assist', 'x.wav', 'x.wav', 'UPLOADED', %s)"
            " RETURNING id",
            (client.account["id"],),
        ).fetchone()["id"]
        versions.start(mid, client.account["id"], c)
    pipeline._persist_transcript(
        mid,
        [
            {"start": 0.0, "end": 4.0, "text": "병환경로업의 결제금액 작성", "speaker": "SPEAKER_00"},
            {"start": 4.0, "end": 9.0, "text": "배송저를 확인해 주세요.", "speaker": "SPEAKER_01"},
            {"start": 9.0, "end": 13.0, "text": "네 확인했습니다.", "speaker": "SPEAKER_00"},
        ],
    )
    pipeline.set_status(mid, "REVIEW_REQUIRED")
    yield mid
    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = %s", (mid,))


@pytest.fixture
def fake_llm(monkeypatch):
    """Record what the model was asked, and reply with whatever the test sets.

    Approving a meeting also queues fact extraction; conftest's autouse
    `fake_extract` keeps that off this list. These tests are about the summary
    and the corrections, and nothing else.
    """
    state = {"prompts": [], "reply": ""}

    def _complete(system, user, json_mode=False):
        state["prompts"].append({"system": system, "user": user, "json_mode": json_mode})
        return state["reply"]

    monkeypatch.setattr(assist, "_complete", _complete)
    return state


def _texts(meeting_id):
    with conn() as c:
        return [
            r["text"] for r in c.execute(
                "SELECT text FROM transcript_segments WHERE meeting_id = %s ORDER BY sequence",
                (meeting_id,),
            ).fetchall()
        ]


# ---------------------------------------------------------------- summary


def test_summary_is_refused_before_approval(meeting, client, fake_llm):
    res = client.post(f"/api/meetings/{meeting}/summary")
    assert res.status_code == 409
    assert fake_llm["prompts"] == []  # not even attempted
    assert assist.get_summary(meeting) is None


def test_summary_is_generated_from_the_approved_transcript_and_stored(
    meeting, client, fake_llm
):
    fake_llm["reply"] = "핵심 요약\n결제 프로세스 논의\n\n결정 사항\n없음"
    client.post(f"/api/meetings/{meeting}/approve")

    body = client.post(f"/api/meetings/{meeting}/summary").json()
    assert body["content"] == fake_llm["reply"]

    # the whole transcript went in, rendered with speaker labels
    sent = fake_llm["prompts"][0]["user"]
    for text in _texts(meeting):
        assert text in sent
    assert "화자 A:" in sent
    assert "Action Items" in fake_llm["prompts"][0]["system"]

    with conn() as c:
        assert c.execute(
            "SELECT content FROM meeting_summaries WHERE meeting_id = %s", (meeting,)
        ).fetchone()["content"] == fake_llm["reply"]


def test_a_stored_summary_is_read_back_without_calling_the_model(meeting, client, fake_llm):
    fake_llm["reply"] = "핵심 요약\n첫 번째 요약"
    client.post(f"/api/meetings/{meeting}/approve")
    client.post(f"/api/meetings/{meeting}/summary")

    fake_llm["prompts"].clear()
    body = client.get(f"/api/meetings/{meeting}/summary").json()
    assert body["content"] == "핵심 요약\n첫 번째 요약"
    assert fake_llm["prompts"] == []


def test_missing_summary_is_a_404(meeting, client):
    client.post(f"/api/meetings/{meeting}/approve")
    assert client.get(f"/api/meetings/{meeting}/summary").status_code == 404


def test_regenerating_replaces_the_summary_rather_than_adding_one(meeting, client, fake_llm):
    client.post(f"/api/meetings/{meeting}/approve")
    fake_llm["reply"] = "핵심 요약\n첫 번째"
    client.post(f"/api/meetings/{meeting}/summary")
    fake_llm["reply"] = "핵심 요약\n두 번째"
    assert client.post(f"/api/meetings/{meeting}/summary").json()["content"] == "핵심 요약\n두 번째"

    with conn() as c:
        rows = c.execute(
            "SELECT content FROM meeting_summaries WHERE meeting_id = %s", (meeting,)
        ).fetchall()
    assert [r["content"] for r in rows] == ["핵심 요약\n두 번째"]


def test_deleting_the_meeting_takes_its_summary(meeting, client, fake_llm):
    fake_llm["reply"] = "핵심 요약\n내용"
    client.post(f"/api/meetings/{meeting}/approve")
    client.post(f"/api/meetings/{meeting}/summary")

    assert client.delete(f"/api/meetings/{meeting}").status_code == 200
    with conn() as c:
        assert c.execute(
            "SELECT count(*) n FROM meeting_summaries WHERE meeting_id = %s", (meeting,)
        ).fetchone()["n"] == 0


# ---------------------------------------------------------------- correction


def test_correction_is_only_offered_at_the_review_gate(meeting, client, fake_llm):
    client.post(f"/api/meetings/{meeting}/approve")
    res = client.post(f"/api/meetings/{meeting}/corrections")
    assert res.status_code == 409
    assert fake_llm["prompts"] == []


def test_correction_sees_the_whole_transcript(meeting, client, fake_llm):
    fake_llm["reply"] = '{"corrections": []}'
    assert client.post(f"/api/meetings/{meeting}/corrections").status_code == 200

    prompt = fake_llm["prompts"][0]
    assert prompt["json_mode"] is True
    for i, text in enumerate(_texts(meeting)):
        assert f"{i}: {text}" in prompt["user"]  # every line, with its sequence


def test_only_changed_segments_come_back(meeting, client, fake_llm):
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": 0, "after": "병원 경로별 결제금액 작성"},
        {"sequence": 2, "after": "네 확인했습니다."},          # unchanged - dropped
        {"sequence": 99, "after": "존재하지 않는 문장"},        # unknown - dropped
        {"sequence": 1, "after": "   "},                       # empty - dropped
    ]})
    suggestions = client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"]

    assert suggestions == [
        {"sequence": 0, "before": "병환경로업의 결제금액 작성", "after": "병원 경로별 결제금액 작성"}
    ]


def test_an_unparseable_reply_yields_nothing_rather_than_garbage(meeting, client, fake_llm):
    fake_llm["reply"] = "죄송합니다, JSON이 아닙니다"
    assert client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"] == []


def test_a_suggestion_changes_nothing_on_its_own(meeting, client, fake_llm):
    before = _texts(meeting)
    fake_llm["reply"] = json.dumps(
        {"corrections": [{"sequence": 0, "after": "병원 경로별 결제금액 작성"}]}
    )
    client.post(f"/api/meetings/{meeting}/corrections")

    assert _texts(meeting) == before
    with conn() as c:
        row = c.execute("SELECT status FROM meetings WHERE id = %s", (meeting,)).fetchone()
        chunks = c.execute(
            "SELECT count(*) n FROM chunks WHERE meeting_id = %s", (meeting,)
        ).fetchone()["n"]
    assert row["status"] == "REVIEW_REQUIRED"  # never approved as a side effect
    assert chunks == 0                          # and never indexed


def test_the_existing_save_is_what_persists_a_correction(meeting, client, fake_llm):
    fake_llm["reply"] = json.dumps(
        {"corrections": [{"sequence": 0, "after": "병원 경로별 결제금액 작성"}]}
    )
    suggestion = client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"][0]

    res = client.patch(
        f"/api/meetings/{meeting}/transcript",
        json={"segments": [{"sequence": suggestion["sequence"], "text": suggestion["after"]}]},
    )
    assert res.status_code == 200 and res.json()["updated"] == 1
    assert _texts(meeting)[0] == "병원 경로별 결제금액 작성"

    with conn() as c:
        assert c.execute(
            "SELECT status FROM meetings WHERE id = %s", (meeting,)
        ).fetchone()["status"] == "REVIEW_REQUIRED"  # still waiting for a human
