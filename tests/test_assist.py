"""Meeting summary and AI transcript post-correction.

Both call OpenAI over the whole transcript and neither may write to it. The
correction path in particular must stay a suggestion: the reviewer applies it in
the browser and saves through the existing PATCH, so approval keeps its meaning.

Correction is context-aware, which is a claim about the *prompt*: the model is
shown the conversation, told that an ASR token may itself be a mis-hearing, and
told to abstain when the surrounding turns do not support a fix. None of that
can be asserted against a real completion, so what is pinned here is what the
model is asked and what the application accepts back — the judgement itself is
human UAT.
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


def test_correction_sees_the_whole_conversation_in_order(meeting, client, fake_llm):
    """Every line, numbered, timed, and attributed.

    A window would have to choose a target; sending the transcript in one request
    means every line already has the line before it and the line after it, which
    is the context a mis-heard word is caught from — and it is one OpenAI call
    for the meeting rather than one per segment.
    """
    fake_llm["reply"] = '{"corrections": []}'
    assert client.post(f"/api/meetings/{meeting}/corrections").status_code == 200

    prompt = fake_llm["prompts"][0]
    assert prompt["json_mode"] is True
    lines = prompt["user"].splitlines()
    assert lines == [
        "0 [00:00~00:04] 화자 A: 병환경로업의 결제금액 작성",
        "1 [00:04~00:09] 화자 B: 배송저를 확인해 주세요.",
        "2 [00:09~00:13] 화자 A: 네 확인했습니다.",
    ]


def test_the_prompt_states_the_three_policies_the_feature_rests_on(client, meeting, fake_llm):
    """Context-aware correction is a prompt contract before it is anything else.

    Grammar-only repair is exactly the failure this replaced — a fluent sentence
    that keeps the mis-heard word — so the instructions have to say that the
    token itself may be wrong, that a fix has to survive the surrounding turns,
    and that not answering is the default.
    """
    fake_llm["reply"] = '{"corrections": []}'
    client.post(f"/api/meetings/{meeting}/corrections")
    system = fake_llm["prompts"][0]["system"]

    assert "오인식" in system                       # the token itself may be wrong
    assert "기존 단어를 무조건 보존하지 마세요" in system
    assert "앞 발화" in system and "뒤 발화" in system   # the turns around it
    assert "상대의 대답" in system                   # response compatibility
    assert "확신이 없으면" in system                 # abstention
    assert "제안이 많다고 좋은 것이 아니며" in system
    # information that must survive a correction untouched
    for word in ("사람 이름", "숫자", "금액", "날짜", "기한", "담당자"):
        assert word in system
    assert "뒤집지 마세요" in system                 # negation
    assert "말투를 바꾸지 마세요" in system           # not a rewriting tool


def test_only_changed_segments_come_back(meeting, client, fake_llm):
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": 0, "after": "병원 경로별 결제금액 작성", "reason": "앞뒤 문맥이 결제 논의입니다."},
        {"sequence": 2, "after": "네 확인했습니다.", "reason": "그대로"},   # unchanged - dropped
        {"sequence": 99, "after": "존재하지 않는 문장", "reason": "없는 줄"},  # unknown - dropped
        {"sequence": 1, "after": "   ", "reason": "빈 문장"},              # empty - dropped
    ]})
    suggestions = client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"]

    assert suggestions == [{
        "sequence": 0,
        "before": "병환경로업의 결제금액 작성",
        "after": "병원 경로별 결제금액 작성",
        "reason": "앞뒤 문맥이 결제 논의입니다.",
    }]


def test_a_correction_with_no_stated_basis_is_not_offered(meeting, client, fake_llm):
    """The abstention gate, enforced rather than trusted.

    "확신이 없으면 고치지 마세요" is an instruction a model can ignore; requiring
    it to say *why* — and dropping the suggestion when it cannot — is the same
    rule the application can check. A change nobody can justify from the
    surrounding turns is precisely the confident-but-incoherent rewrite this is
    meant to stop.
    """
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": 0, "after": "병원 경로별 결제금액 작성"},               # no reason
        {"sequence": 1, "after": "배송지를 확인해 주세요.", "reason": "  "},  # blank
        {"sequence": 2, "after": "네, 확인했습니다.", "reason": 7},           # not a sentence
    ]})
    assert client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"] == []


def test_one_suggestion_per_segment(meeting, client, fake_llm):
    """Two cards for one line would be two 반영 buttons writing over each other."""
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": 0, "after": "병원 경로별 결제금액 작성", "reason": "첫 번째"},
        {"sequence": 0, "after": "병원 경로별 결제 금액 작성", "reason": "두 번째"},
    ]})
    suggestions = client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"]
    assert [s["after"] for s in suggestions] == ["병원 경로별 결제금액 작성"]


def test_a_sequence_that_is_not_a_number_is_dropped_rather_than_raised(
    meeting, client, fake_llm
):
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": [0], "after": "무엇이든", "reason": "근거"},
        {"sequence": "0", "after": "무엇이든", "reason": "근거"},
        {"after": "번호가 없음", "reason": "근거"},
    ]})
    res = client.post(f"/api/meetings/{meeting}/corrections")
    assert res.status_code == 200
    assert res.json()["suggestions"] == []


def test_an_unparseable_reply_yields_nothing_rather_than_garbage(meeting, client, fake_llm):
    fake_llm["reply"] = "죄송합니다, JSON이 아닙니다"
    assert client.post(f"/api/meetings/{meeting}/corrections").json()["suggestions"] == []


def test_a_suggestion_changes_nothing_on_its_own(meeting, client, fake_llm):
    before = _texts(meeting)
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": 0, "after": "병원 경로별 결제금액 작성", "reason": "결제 논의 문맥"},
    ]})
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
    fake_llm["reply"] = json.dumps({"corrections": [
        {"sequence": 0, "after": "병원 경로별 결제금액 작성", "reason": "결제 논의 문맥"},
    ]})
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


# ------------------------------------------------- the UAT regression case


@pytest.fixture
def phone_call(client):
    """The three turns the previous build got wrong.

    "혹시 턱 되실까요, 잠깐?" was corrected to "혹시 턱 괜찮으실까요, 잠깐?" —
    fluent, and nonsense: the line before it is 여보세요 and the line after it is
    a bare 네, a shape in which nobody is asking about a jaw. The mis-heard token
    was the thing to fix and grammar repair kept it.
    """
    from app.services import versions

    with conn() as c:
        mid = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status,"
            " owner_user_id) VALUES ('pytest 통화', 'x.wav', 'x.wav', 'UPLOADED', %s)"
            " RETURNING id",
            (client.account["id"],),
        ).fetchone()["id"]
        versions.start(mid, client.account["id"], c)
    pipeline._persist_transcript(
        mid,
        [
            {"start": 1.0, "end": 4.0, "text": "여보세요? 네, 전화를 받습니다.",
             "speaker": "SPEAKER_00"},
            {"start": 4.0, "end": 7.0, "text": "네, 안녕하세요. 혹시 턱 되실까요, 잠깐?",
             "speaker": "SPEAKER_00"},
            {"start": 7.0, "end": 8.0, "text": "네.", "speaker": "SPEAKER_01"},
        ],
    )
    pipeline.set_status(mid, "REVIEW_REQUIRED")
    yield mid
    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = %s", (mid,))


def test_the_turn_before_and_after_the_mis_heard_line_are_both_in_the_prompt(
    phone_call, client, fake_llm
):
    """What the old prompt did not have.

    Not asserted: that the model answers "통화". A text-only post-correction
    cannot listen again, so the right answer is either a contextually sound
    proposal or no proposal at all, and which one a real completion gives is
    human UAT. What is testable is that the evidence for that judgement was
    actually sent — the previous turn, the line itself, the reply, each with its
    speaker and its clock.
    """
    fake_llm["reply"] = '{"corrections": []}'
    client.post(f"/api/meetings/{phone_call}/corrections")

    lines = fake_llm["prompts"][0]["user"].splitlines()
    assert lines == [
        "0 [00:01~00:04] 화자 A: 여보세요? 네, 전화를 받습니다.",
        "1 [00:04~00:07] 화자 A: 네, 안녕하세요. 혹시 턱 되실까요, 잠깐?",
        "2 [00:07~00:08] 화자 B: 네.",
    ]
    # The speaker changes at the answer, which is what makes 네 a reply rather
    # than the same person carrying on.
    assert "화자 B" in lines[2] and "화자 A" in lines[1]


def test_a_proposal_for_that_line_arrives_with_its_reasoning(phone_call, client, fake_llm):
    fake_llm["reply"] = json.dumps({"corrections": [{
        "sequence": 1,
        "after": "네, 안녕하세요. 혹시 통화 되실까요, 잠깐?",
        "reason": "전화 연결 직후이고 상대가 '네.'로 답해, '턱'은 '통화'의 오인식으로 보입니다.",
    }]})
    body = client.post(f"/api/meetings/{phone_call}/corrections").json()

    assert body["suggestions"] == [{
        "sequence": 1,
        "before": "네, 안녕하세요. 혹시 턱 되실까요, 잠깐?",
        "after": "네, 안녕하세요. 혹시 통화 되실까요, 잠깐?",
        "reason": "전화 연결 직후이고 상대가 '네.'로 답해, '턱'은 '통화'의 오인식으로 보입니다.",
    }]
    assert _texts(phone_call)[1] == "네, 안녕하세요. 혹시 턱 되실까요, 잠깐?"  # still a draft


def test_abstaining_on_that_line_is_a_valid_answer(phone_call, client, fake_llm):
    """Not correcting is the safe outcome, and it has to reach the screen as one.

    An empty list is the model saying it could not justify a change, and the
    panel says so in as many words. It is not an error and it is not a retry.
    """
    fake_llm["reply"] = '{"corrections": []}'
    res = client.post(f"/api/meetings/{phone_call}/corrections")
    assert res.status_code == 200
    assert res.json()["suggestions"] == []
