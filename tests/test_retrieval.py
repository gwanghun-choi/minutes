"""Temporal and relationship-aware retrieval, end to end through the chat API.

Structured facts change what the model is shown, not the rules it is shown it
under. The scope invariant is the one to watch: a chosen set of meetings binds
fact retrieval exactly as hard as it binds chunk retrieval, and a chronology
question must never quietly reach a meeting outside it.
"""
import json
from types import SimpleNamespace

import pytest
from conftest import requires_db

from app import config
from app.services import intelligence, pipeline, rag

pytestmark = requires_db

DEFAULT_PLAN = {
    "fact_types": list(intelligence.FACT_TYPES),
    "participant_role": None,
    "self_reference": False,
}


def _msg(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class FakeOpenAI:
    """One fake for both calls: the planner asks for JSON, the generator does not."""

    calls: list = []
    plan: dict = {}

    def __init__(self, api_key=None):
        self.chat = SimpleNamespace(completions=self)

    def create(self, **kwargs):
        FakeOpenAI.calls.append(kwargs)
        if kwargs.get("response_format"):
            question = kwargs["messages"][-1]["content"]
            return _msg(json.dumps({"query": question, **DEFAULT_PLAN, **FakeOpenAI.plan}))
        # The answer echoes the evidence, so a test can assert exactly what the
        # generator was allowed to see and in which order.
        return _msg("근거 요약: " + kwargs["messages"][-1]["content"])


@pytest.fixture
def openai(monkeypatch):
    FakeOpenAI.calls, FakeOpenAI.plan = [], {}
    monkeypatch.setattr(config, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    return FakeOpenAI


def evidence():
    """What the answer generator was actually given."""
    generation = [c for c in FakeOpenAI.calls if not c.get("response_format")]
    return generation[-1]["messages"][-1]["content"]


@pytest.fixture
def queries(monkeypatch):
    """Record the query string each retrieval layer was called with."""
    seen = {"facts": [], "chunks": []}
    for name, key, module in (("search", "facts", intelligence), ("search", "chunks", rag)):
        original = getattr(module, name)

        def spy(query, *a, _o=original, _k=key, **kw):
            seen[_k].append(query)
            return _o(query, *a, **kw)

        monkeypatch.setattr(module, name, spy)
    return seen


@pytest.fixture
def built(make_meeting, fake_extract):
    """Factory: an approved meeting whose facts are exactly what the test names."""

    def make(title, lines, facts, days_ago=0, held_ago=None):
        mid = make_meeting(title, lines, days_ago=days_ago, held_ago=held_ago)
        utterances, _ = pipeline.load_transcript(mid)
        seg = [u["id"] for u in utterances]
        spk = {u["display_name"]: u["speaker_id"] for u in utterances}
        fake_extract["reply"] = json.dumps({
            "facts": [
                {**f,
                 "source_segment_ids": [seg[i] for i in f["source_segment_ids"]],
                 **{k: spk[v] for k, v in f.items() if k.endswith("_speaker_id")}}
                for f in facts
            ]
        })
        intelligence.build(mid)
        return mid, spk

    return make


REQUEST_LINES = [
    ("SPEAKER_00", "박 대리님, 금요일까지 API 문서 정리해주세요."),
    ("SPEAKER_01", "네, 제가 맡겠습니다."),
]
REQUEST_FACT = {
    "fact_type": "REQUEST",
    "content": "박 대리가 API 문서를 정리한다",
    "source_segment_ids": [0, 1],
    "requester_speaker_id": "화자 A",
    "assignee_speaker_id": "화자 B",
    "deadline_text": "금요일",
    "status": "OPEN",
}


# ------------------------------------------------------- relationship queries


def test_who_requested_it_is_answered_from_the_requester_role(client, built, openai):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    openai.plan = {"participant_role": "REQUESTER", "fact_types": ["REQUEST"]}
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "누가 요청했어?"}
    ).json()

    fact = next(s for s in body["sources"] if s["kind"] == "fact")
    assert fact["participants"]["요청자"] == "화자 A"
    assert "요청자: 화자 A" in evidence()


def test_who_is_assigned_is_answered_from_the_assignee_role(client, built, openai):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    openai.plan = {"participant_role": "ASSIGNEE"}
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "누가 맡았어?"}
    ).json()
    fact = next(s for s in body["sources"] if s["kind"] == "fact")
    assert fact["participants"]["담당자"] == "화자 B"


def test_a_role_filter_excludes_a_fact_that_has_nobody_in_that_role(
    client, built, openai
):
    mid, _ = built("결정 회의", REQUEST_LINES, [
        {"fact_type": "DECISION", "content": "서버는 8월에 도입한다",
         "source_segment_ids": [0], "deadline_text": None, "status": "OPEN"},
    ])
    openai.plan = {"participant_role": "REQUESTER"}
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "누가 요청했어?"}
    ).json()
    assert [s for s in body["sources"] if s["kind"] == "fact"] == []


def test_the_deadline_travels_with_the_fact_and_reaches_the_model(
    client, built, openai
):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "기한이 언제야?"}
    ).json()
    fact = next(s for s in body["sources"] if s["kind"] == "fact")
    assert fact["deadline_text"] == "금요일"
    assert "기한: 금요일" in evidence()


def test_a_fact_always_reaches_the_model_with_the_words_it_came_from(
    client, built, openai
):
    """No structured claim without its 원문 — that is the provenance contract."""
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "API 문서"}
    ).json()
    fact = next(s for s in body["sources"] if s["kind"] == "fact")
    assert "API 문서 정리해주세요" in fact["text"]
    assert fact["source_segment_ids"]
    assert fact["meeting_id"] == mid and fact["meeting_title"] == "API 회의"
    assert "원문: " in evidence()


# ------------------------------------------------------------------- "내가"


def test_my_own_requests_are_found_through_my_speaker_mapping(client, built, openai):
    mid, spk = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    client.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 A"]})
    openai.plan = {"self_reference": True, "participant_role": "REQUESTER"}
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "내가 요청한 게 뭐야?"}
    ).json()
    fact = next(s for s in body["sources"] if s["kind"] == "fact")
    assert fact["participants"]["요청자"] == "화자 A"
    # only facts naming my speaker — no unfiltered excerpts alongside them
    assert {s["kind"] for s in body["sources"]} == {"fact"}


def test_someone_elses_request_is_not_mine(client, built, openai):
    """Mapped to the assignee, "내가 요청한 것" has to come back empty, not wrong.

    Chunks are left out of a self-scoped question entirely: they carry no
    participant filter, so an unfiltered excerpt of somebody else's request would
    be exactly the wrong thing to put in front of the model.
    """
    mid, spk = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    client.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 B"]})
    openai.plan = {"self_reference": True, "participant_role": "REQUESTER"}
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "내가 요청한 게 뭐야?"}
    ).json()
    assert body["sources"] == []
    assert body["answer"] == rag.NO_ANSWER


def test_without_a_speaker_mapping_the_answer_refuses_instead_of_guessing(
    client, built, openai
):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    openai.plan = {"self_reference": True, "participant_role": "REQUESTER"}
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "내가 요청한 게 뭐야?"}
    ).json()
    assert body["answer"] == rag.NO_IDENTITY
    assert body["sources"] == []
    # and it is not offered as a scope problem, because widening would not help
    assert body["scope_miss"] is False


# ------------------------------------------------------------ temporal change

SERVER_MEETINGS = [
    ("1차 회의", "서버는 8월에 도입한다", 30),
    ("2차 회의", "서버 도입은 9월로 연기한다", 20),
    ("3차 회의", "서버 도입은 취소한다", 10),
]


@pytest.fixture
def server_history(built):
    ids = []
    for title, decision, days_ago in SERVER_MEETINGS:
        mid, _ = built(
            title, [("SPEAKER_00", decision + ".")],
            [{"fact_type": "DECISION", "content": decision,
              "source_segment_ids": [0], "deadline_text": None, "status": "OPEN"}],
            days_ago=days_ago,
        )
        ids.append(mid)
    return ids


def test_decisions_reach_the_model_in_the_order_the_meetings_happened(
    client, server_history, openai
):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "서버 도입 결정이 어떻게 바뀌었어?", "top_k": 12},
    )
    shown = evidence()
    assert shown.index("8월에 도입") < shown.index("9월로 연기") < shown.index("취소")


def test_a_scoped_chronology_never_reaches_the_meeting_outside_the_scope(
    client, server_history, openai
):
    first, second, third = server_history
    sid = client.post(
        "/api/chat/sessions", json={"scope_meeting_ids": [first, second]}
    ).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "서버 도입 결정이 어떻게 바뀌었어?", "top_k": 12},
    ).json()

    assert {s["meeting_id"] for s in body["sources"]} <= {first, second}
    shown = evidence()
    assert "8월에 도입" in shown and "9월로 연기" in shown
    assert "취소" not in shown  # the third meeting was never searched


def test_an_explicit_global_retry_reaches_the_facts_it_was_scoped_away_from(
    client, server_history, openai
):
    first, second, third = server_history
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [first]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "서버 도입이 취소됐어?", "global_override": True, "top_k": 12},
    ).json()
    assert third in {s["meeting_id"] for s in body["sources"]}
    # the chat's own scope is untouched by the one-off widening
    assert list(client.get(f"/api/chat/sessions/{sid}").json()["session"]["scope_meeting_ids"]) \
        == [first]


# -------------------------------------------------- multi-turn query rewrite


def test_a_follow_up_pronoun_is_resolved_for_retrieval_and_only_for_retrieval(
    client, built, openai, queries
):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "API 문서 정리는 누가 맡았어?"}
    )

    openai.plan = {"query": "박 대리에게 API 문서 정리를 누가 요청했지?",
                   "participant_role": "REQUESTER"}
    client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "그 사람한테 누가 요청했지?"}
    )

    # retrieval saw the resolved question ...
    assert queries["facts"][-1] == "박 대리에게 API 문서 정리를 누가 요청했지?"
    assert queries["chunks"][-1] == "박 대리에게 API 문서 정리를 누가 요청했지?"
    # ... and the generator still saw the question exactly as it was typed
    assert evidence().endswith("그 사람한테 누가 요청했지?")


def test_the_planner_is_given_the_previous_turns(client, built, openai):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "누가 맡았어?"})
    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "그 사람 누구야?"})

    planning = [c for c in openai.calls if c.get("response_format")][-1]
    roles = [m["role"] for m in planning["messages"]]
    assert roles[0] == "system" and roles[-1] == "user"
    assert planning["messages"][-1]["content"] == "그 사람 누구야?"
    assert "누가 맡았어?" in [m["content"] for m in planning["messages"][1:-1]]


def test_an_unusable_plan_falls_back_to_the_question_as_typed(
    client, built, openai, queries, monkeypatch
):
    mid, _ = built("API 회의", REQUEST_LINES, [REQUEST_FACT])

    def broken(**kwargs):
        FakeOpenAI.calls.append(kwargs)
        if kwargs.get("response_format"):
            return _msg("이건 JSON이 아닙니다")
        return _msg("답변")

    monkeypatch.setattr(FakeOpenAI, "create", lambda self, **kw: broken(**kw))
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "누가 맡았어?"})

    assert queries["facts"][-1] == "누가 맡았어?"
    assert queries["chunks"][-1] == "누가 맡았어?"


def test_planning_is_skipped_without_an_api_key(monkeypatch):
    monkeypatch.setattr(config, "OPENAI_API_KEY", None)
    assert rag.plan("그 부서는?", [{"role": "user", "content": "어느 부서야?"}]) == {
        "query": "그 부서는?", **DEFAULT_PLAN
    }


# ----------------------------------------------------- plain RAG still works


def test_a_meeting_with_no_facts_still_answers_from_its_transcript(
    client, make_meeting, openai
):
    mid = make_meeting("일반 회의", [("SPEAKER_00", "예산은 3천만 원으로 잡았습니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "예산은 얼마야?"}
    ).json()
    assert body["sources"]
    assert {s["kind"] for s in body["sources"]} == {"chunk"}
    assert "3천만 원" in evidence()


# --------------------------------------------- held_at vs the upload date

DECISIONS = [
    # (title, decision, held_ago, days_ago) - held oldest first, uploaded newest
    # first. Ordering by created_at would show this timeline backwards.
    ("1차 회의", "서버는 8월에 도입한다", 30, 1),
    ("2차 회의", "서버 도입은 9월로 연기한다", 20, 2),
    ("3차 회의", "서버 도입은 취소한다", 10, 3),
]


def decision(content):
    return [{"fact_type": "DECISION", "content": content, "source_segment_ids": [0],
             "deadline_text": None, "status": "DONE"}]


def test_the_order_follows_when_the_meetings_were_held_not_when_they_were_uploaded(
    client, built, openai
):
    for title, text, held_ago, days_ago in DECISIONS:
        built(title, [("SPEAKER_00", text + ".")], decision(text),
              days_ago=days_ago, held_ago=held_ago)

    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "서버 도입 결정이 어떻게 바뀌었어?", "top_k": 12},
    )
    shown = evidence()
    assert shown.index("8월에 도입") < shown.index("9월로 연기") < shown.index("취소")


def test_a_meeting_with_no_held_at_orders_on_its_upload_date_and_says_so(
    client, built, openai
):
    """The fallback has to be deterministic, and it has to be honest: a date
    nobody entered is a registration date and is never shown as the meeting's."""
    built("과거 회의", [("SPEAKER_00", "예산은 8월에 확정한다.")],
          decision("예산은 8월에 확정한다"), days_ago=30)          # held_at NULL
    built("최근 회의", [("SPEAKER_00", "예산 확정은 9월로 옮긴다.")],
          decision("예산 확정은 9월로 옮긴다"), held_ago=5)

    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    body = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "예산 확정 결정이 어떻게 바뀌었어?", "top_k": 12},
    ).json()

    shown = evidence()
    assert shown.index("8월에 확정") < shown.index("9월로 옮긴다")
    labels = {s["meeting_title"]: s["meeting_date_label"]
              for s in body["sources"] if s["kind"] == "fact"}
    assert labels["과거 회의"].endswith("등록")
    assert not labels["최근 회의"].endswith("등록")


def test_a_status_the_meeting_never_stated_is_shown_as_unconfirmed(client, built, openai):
    """UNKNOWN must not reach the model as "진행 중": a question about what is
    still outstanding would then count facts nobody gave a status to."""
    built("API 회의", REQUEST_LINES, [{**REQUEST_FACT, "status": "UNKNOWN"}])

    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "아직 안 끝난 요청이 뭐야?"},
    )
    shown = evidence()
    assert "상태: 미확인" in shown
    assert "상태: 진행 중" not in shown
