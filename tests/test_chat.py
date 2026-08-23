"""Persistent chat: ownership, history, and what the search scope is allowed to reach.

The scope invariant is the important one. When a user has named the meetings to
search, nothing in the backend may look outside them — a wider search is only
ever a second request the user asked for.
"""
from types import SimpleNamespace

import pytest
from conftest import requires_db

from app import config
from app.db import conn
from app.services import pipeline, rag

pytestmark = requires_db


class FakeOpenAI:
    """Stands in for the OpenAI client and records every request it is given."""

    calls: list[dict] = []

    def __init__(self, api_key=None):
        self.chat = SimpleNamespace(completions=self)

    def create(self, **kwargs):
        FakeOpenAI.calls.append(kwargs)
        evidence = kwargs["messages"][-1]["content"]
        # Behave like the real prompt tells the model to: answer only from the
        # evidence, and say so plainly when it is not there.
        content = "재무지원실입니다. [1]" if "재무지원실" in evidence else rag.NO_ANSWER
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


@pytest.fixture
def fake_openai(monkeypatch):
    FakeOpenAI.calls = []
    monkeypatch.setattr(config, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    return FakeOpenAI


# ---------------------------------------------------------------- sessions


def test_a_new_chat_starts_empty_and_global(client):
    session = client.post("/api/chat/sessions", json={}).json()
    assert session["title"] == "새 채팅"
    assert list(session["scope_meeting_ids"]) == []
    body = client.get(f"/api/chat/sessions/{session['id']}").json()
    assert body["messages"] == []


def test_sessions_are_listed_newest_first(client):
    a = client.post("/api/chat/sessions", json={}).json()["id"]
    b = client.post("/api/chat/sessions", json={}).json()["id"]
    listed = [s["id"] for s in client.get("/api/chat/sessions").json()]
    assert listed.index(b) < listed.index(a)


def test_another_users_chat_is_unreachable(login):
    """Ownership is in the SQL. A guessed id is a 404, not somebody else's data."""
    mine, theirs = login(), login()
    sid = mine.post("/api/chat/sessions", json={}).json()["id"]

    assert theirs.get(f"/api/chat/sessions/{sid}").status_code == 404
    assert theirs.delete(f"/api/chat/sessions/{sid}").status_code == 404
    assert theirs.patch(
        f"/api/chat/sessions/{sid}", json={"scope_meeting_ids": [1]}
    ).status_code == 404
    assert theirs.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "예산"}
    ).status_code == 404
    assert sid not in [s["id"] for s in theirs.get("/api/chat/sessions").json()]
    # and it is still there, untouched
    assert mine.get(f"/api/chat/sessions/{sid}").status_code == 200


def test_deleting_a_chat_removes_its_messages(client, fake_openai):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "예산"})
    with conn() as c:
        assert c.execute(
            "SELECT count(*) n FROM chat_messages WHERE session_id = %s", (sid,)
        ).fetchone()["n"] == 2

    assert client.delete(f"/api/chat/sessions/{sid}").status_code == 200
    assert client.get(f"/api/chat/sessions/{sid}").status_code == 404
    with conn() as c:
        assert c.execute(
            "SELECT count(*) n FROM chat_messages WHERE session_id = %s", (sid,)
        ).fetchone()["n"] == 0


def test_the_first_question_names_the_chat(client, fake_openai):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "결제 프로세스는 어떻게 되나요?"})
    assert client.get(f"/api/chat/sessions/{sid}").json()["session"]["title"] \
        == "결제 프로세스는 어떻게 되나요?"

    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "그다음은?"})
    assert client.get(f"/api/chat/sessions/{sid}").json()["session"]["title"] \
        == "결제 프로세스는 어떻게 되나요?"  # a later question does not rename it


def test_a_chat_can_be_renamed_and_the_name_survives_a_reload(client):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    res = client.patch(f"/api/chat/sessions/{sid}/title", json={"title": "  8월 배포 논의  "})
    assert res.status_code == 200
    assert res.json()["title"] == "8월 배포 논의"  # trimmed, not rejected

    assert client.get(f"/api/chat/sessions/{sid}").json()["session"]["title"] == "8월 배포 논의"
    assert [s["title"] for s in client.get("/api/chat/sessions").json()][0] == "8월 배포 논의"


def test_a_blank_name_is_refused_and_leaves_the_old_one(client):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.patch(f"/api/chat/sessions/{sid}/title", json={"title": "이름 있음"})

    for blank in ("", "   ", "\n"):
        assert client.patch(
            f"/api/chat/sessions/{sid}/title", json={"title": blank}
        ).status_code == 400
    assert client.get(f"/api/chat/sessions/{sid}").json()["session"]["title"] == "이름 있음"


def test_a_long_name_is_truncated_rather_than_refused(client):
    from app.api.chat import TITLE_MAX

    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    title = client.patch(
        f"/api/chat/sessions/{sid}/title", json={"title": "가" * (TITLE_MAX + 30)}
    ).json()["title"]
    assert title == "가" * TITLE_MAX


def test_a_renamed_chat_is_not_renamed_again_by_its_first_question(client, fake_openai):
    """The auto-title only fills in the default. A name a person chose stands."""
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.patch(f"/api/chat/sessions/{sid}/title", json={"title": "내가 정한 이름"})

    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "결제 프로세스는?"})
    assert client.get(f"/api/chat/sessions/{sid}").json()["session"]["title"] == "내가 정한 이름"


def test_renaming_someone_elses_chat_is_a_404(login):
    mine, theirs = login(), login()
    sid = mine.post("/api/chat/sessions", json={}).json()["id"]

    assert theirs.patch(
        f"/api/chat/sessions/{sid}/title", json={"title": "가로채기"}
    ).status_code == 404
    assert mine.get(f"/api/chat/sessions/{sid}").json()["session"]["title"] == "새 채팅"


def test_renaming_needs_a_session(anon):
    assert anon.patch("/api/chat/sessions/1/title", json={"title": "x"}).status_code == 401


def test_a_reopened_chat_shows_the_same_answer_and_the_same_evidence(
    client, make_meeting, fake_openai
):
    mid = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    live = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "어음은 어느 부서인가요?"}
    ).json()
    assert live["sources"]

    reloaded = client.get(f"/api/chat/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in reloaded] == ["user", "assistant"]
    assert reloaded[1]["content"] == live["answer"]
    assert reloaded[1]["sources"] == live["sources"]
    # provenance survives the round trip through JSONB
    source = reloaded[1]["sources"][0]
    assert source["meeting_id"] == mid
    assert {"meeting_title", "speakers", "time_label", "text", "score"} <= set(source)


# ------------------------------------------------------------------- 출처


def test_the_response_separates_what_was_retrieved_from_what_was_cited(
    client, make_meeting, fake_openai
):
    """Top-K goes to the model; the answer rests on the excerpts it named.

    `sources` is the retrieved set — what the model saw, what the row stores, and
    what the scope invariant is observed through. `cited_sources` is the subset
    the answer quoted, and it is the only one a reader is shown.
    """
    make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 재무 검토 뒤 9월입니다.")])
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    body = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "재무 관련 안건", "top_k": 12},
    ).json()

    assert len(body["sources"]) > 1, "이 시나리오는 후보가 둘 이상이어야 의미가 있다"
    assert body["answer"] == "재무지원실입니다. [1]"
    assert [s["index"] for s in body["cited_sources"]] == [1]
    # the cited card is the retrieved row itself, not a copy shaped differently
    assert body["cited_sources"][0] == body["sources"][0]


def test_a_reopened_chat_shows_the_same_cited_evidence(client, make_meeting, fake_openai):
    """Recomputed from the stored answer on read, so it cannot drift from live."""
    make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 재무 검토 뒤 9월입니다.")])
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    live = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "재무 관련 안건", "top_k": 12},
    ).json()

    reloaded = client.get(f"/api/chat/sessions/{sid}").json()["messages"][1]
    assert reloaded["cited_sources"] == live["cited_sources"]
    # …and nothing was dropped from storage to make that true
    assert reloaded["sources"] == live["sources"]
    assert len(reloaded["sources"]) > len(reloaded["cited_sources"])


def test_an_answer_that_cites_nothing_shows_no_evidence(client, make_meeting, fake_openai):
    """The model found the excerpts unhelpful and said so. There is no 출처 to
    show, and the retrieved candidates are not a substitute for one."""
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a]}).json()["id"]
    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "GPU 일정", "top_k": 12}
    ).json()

    assert body["answer"] == rag.NO_ANSWER
    assert body["sources"], "검색은 성공했다 — 사라진 것은 인용뿐이다"
    assert body["cited_sources"] == []


# ---------------------------------------------------------------- multi-turn


def test_previous_turns_reach_the_answer_generator(client, make_meeting, fake_openai):
    """The follow-up says "그 부서" and only the history explains what that is."""
    mid = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]

    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "어음은 어느 부서 협조가 필요해?"})
    client.post(f"/api/chat/sessions/{sid}/messages", json={"question": "그 부서는 어떤 기준으로 기록해?"})

    messages = fake_openai.calls[-1]["messages"]
    assert messages[0]["role"] == "system"
    assert messages[-1]["content"].endswith("그 부서는 어떤 기준으로 기록해?")
    history = messages[1:-1]
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert history[0]["content"] == "어음은 어느 부서 협조가 필요해?"
    assert "재무지원실" in history[1]["content"]


def test_history_is_bounded(client, make_meeting, fake_openai, monkeypatch):
    monkeypatch.setattr(rag, "HISTORY_MESSAGES", 2)
    mid = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    for i in range(4):
        client.post(f"/api/chat/sessions/{sid}/messages", json={"question": f"질문 {i}"})

    history = fake_openai.calls[-1]["messages"][1:-1]
    assert len(history) == 2  # the most recent turn only
    assert history[0]["content"] == "질문 2"


# ---------------------------------------------------------------- scope


def test_global_scope_searches_every_approved_meeting(client, make_meeting, fake_openai):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "GPU", "top_k": 12}
    ).json()
    found = {s["meeting_id"] for s in body["sources"]}
    assert a in found
    assert body["scope_miss"] is False  # a global chat never offers to widen


def test_a_single_meeting_scope_is_a_hard_restriction(client, make_meeting, fake_openai):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [b]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "GPU 서버 일정", "top_k": 12}
    ).json()
    assert {s["meeting_id"] for s in body["sources"]} == {b}
    assert a not in {s["meeting_id"] for s in body["sources"]}


def test_several_meetings_can_be_scoped_at_once(client, make_meeting, fake_openai):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    c_id = make_meeting("채용 회의", [("SPEAKER_00", "채용 인원은 두 명입니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a, b]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "일정", "top_k": 12}
    ).json()
    assert {s["meeting_id"] for s in body["sources"]} <= {a, b}
    assert c_id not in {s["meeting_id"] for s in body["sources"]}


def test_scope_belongs_to_the_chat_and_survives_a_reload(client, make_meeting):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    scoped = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a]}).json()["id"]
    globals_ = client.post("/api/chat/sessions", json={}).json()["id"]

    client.patch(f"/api/chat/sessions/{scoped}", json={"scope_meeting_ids": [a, b]})

    assert list(client.get(f"/api/chat/sessions/{scoped}").json()["session"]["scope_meeting_ids"]) \
        == [a, b]
    assert list(client.get(f"/api/chat/sessions/{globals_}").json()["session"]["scope_meeting_ids"]) \
        == []


def test_an_unapproved_meeting_cannot_be_scoped_into_evidence(client, make_meeting, fake_openai):
    """Only COMPLETED meetings are offered in the picker, and the gate holds anyway."""
    draft = make_meeting("초안 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    pipeline.set_status(draft, "REVIEW_REQUIRED")
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [draft]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "어음"}
    ).json()
    assert body["sources"] == []


# ------------------------------------------------- explicit global fallback


def test_a_scoped_miss_never_widens_by_itself(client, make_meeting, fake_openai):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a]}).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "어음은 어느 부서야?", "top_k": 12}
    ).json()
    assert body["answer"] == rag.NO_ANSWER
    assert b not in {s["meeting_id"] for s in body["sources"]}
    assert body["scope_miss"] is True  # the user is asked, not answered around
    # nothing the model saw came from outside the scope, either
    assert "재무지원실" not in fake_openai.calls[-1]["messages"][-1]["content"]


def test_an_explicit_retry_searches_globally_without_changing_the_chat(
    client, make_meeting, fake_openai
):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a]}).json()["id"]

    retry = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "어음은 어느 부서야?", "global_override": True, "top_k": 12},
    ).json()
    assert b in {s["meeting_id"] for s in retry["sources"]}
    assert "재무지원실" in retry["answer"]
    assert retry["scope_miss"] is False

    # the chat's own scope is untouched: the next question is scoped again
    session = client.get(f"/api/chat/sessions/{sid}").json()["session"]
    assert list(session["scope_meeting_ids"]) == [a]
    again = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "어음은 어느 부서야?", "top_k": 12}
    ).json()
    assert b not in {s["meeting_id"] for s in again["sources"]}


def test_an_empty_scope_returns_the_chat_to_the_whole_corpus(client, make_meeting, fake_openai):
    """A made-up word, so the assertion cannot be satisfied by another meeting."""
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "크발론 정산은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a]}).json()["id"]
    scoped = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "크발론", "top_k": 12}
    ).json()
    assert b not in {s["meeting_id"] for s in scoped["sources"]}

    client.patch(f"/api/chat/sessions/{sid}", json={"scope_meeting_ids": []})
    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "크발론", "top_k": 12}
    ).json()
    assert b in {s["meeting_id"] for s in body["sources"]}
    assert body["scope_miss"] is False


def test_a_meeting_id_that_does_not_exist_narrows_rather_than_widens(
    client, make_meeting, fake_openai
):
    """A stale id must not silently turn a scoped chat into a global one."""
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    sid = client.post(
        "/api/chat/sessions", json={"scope_meeting_ids": [a, 999_999_999]}
    ).json()["id"]

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "GPU", "top_k": 12}
    ).json()
    assert {s["meeting_id"] for s in body["sources"]} == {a}


def test_a_deleted_meeting_leaves_the_chat_working(client, make_meeting, fake_openai):
    a = make_meeting("GPU 회의", [("SPEAKER_00", "GPU 서버 도입은 9월입니다.")])
    b = make_meeting("결제 회의", [("SPEAKER_00", "어음은 재무지원실 협조가 필요합니다.")])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [a, b]}).json()["id"]
    assert client.delete(f"/api/meetings/{b}").status_code == 200

    body = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"question": "GPU", "top_k": 12}
    ).json()
    assert {s["meeting_id"] for s in body["sources"]} == {a}
    # the id stays on the row: the scope is what the user chose, not what survives
    assert b in list(client.get(f"/api/chat/sessions/{sid}").json()["session"]["scope_meeting_ids"])
