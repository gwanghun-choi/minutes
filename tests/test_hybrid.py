"""Hybrid retrieval: Korean lexical analysis, rank fusion, and grounding.

Split by what each test needs. The fusion, lexeme, citation, and conflict tests
are pure functions and run without a database. The retrieval tests need real
rows, and they are the ones that hold the scope invariant: a chosen set of
meetings binds the lexical axis exactly as hard as it binds the dense one.
"""
import json
from types import SimpleNamespace

import pytest
from conftest import requires_db

from app import config
from app.services import fusion, intelligence, lexical, pipeline, rag

# --------------------------------------------------------------- Kiwi lexemes


def test_a_josa_is_dropped_so_the_stem_is_what_gets_indexed():
    """인증서를 / 인증서가 / 인증서는 must all be searchable as 인증서."""
    for line in ("인증서를 발급했습니다", "인증서가 필요합니다", "인증서는 아직입니다"):
        assert "인증서" in lexical.tokens(line)
    assert "를" not in lexical.tokens("인증서를 발급했습니다")


def test_a_persons_name_survives_as_one_token():
    assert "최광훈" in lexical.tokens("최광훈 대리가 처리하기로 했습니다")


def test_an_english_acronym_is_kept_and_lowercased():
    tokens = lexical.tokens("SSL 인증서와 API 문서, PostgreSQL 16을 확인했습니다")
    assert {"ssl", "api", "postgresql", "16"} <= set(tokens)


def test_numbers_and_dates_are_kept():
    tokens = lexical.tokens("8월 19일까지 350만원을 집행합니다")
    assert {"8", "19", "350"} <= set(tokens)


def test_a_technical_term_is_not_split_into_noise():
    assert "쿠버네티스" in lexical.tokens("쿠버네티스 클러스터를 늘립니다")


def test_a_verb_is_indexed_by_its_stem():
    """남겨주시면 / 남겨드리겠습니다 both have to reach 남기."""
    assert "남기" in lexical.tokens("현관 비밀번호를 남겨주시면 감사하겠습니다")
    assert "남기" in lexical.tokens("통화 종료하고 문자로 남겨드리겠습니다")


def test_a_question_made_only_of_grammar_has_no_lexical_query():
    """"그거 언제까지야?" carries nothing to search an inverted index for. That is
    an empty result the dense axis has to carry, not an error."""
    assert lexical.tsquery("그거 언제까지야?") is None


def test_a_tsquery_operator_can_never_come_out_of_a_question():
    """Whatever a user types, the string handed to to_tsquery is morphemes."""
    query = lexical.tsquery("SSL & (인증서 | 문서) ! 발급:*")
    assert query and set("&!():*") & set(query) == set()
    assert " | " in query


def test_the_same_word_twice_is_indexed_twice():
    """ts_rank_cd reads term frequency and position; a set would erase both."""
    assert lexical.tokens("배포 배포 배포").count("배포") == 3


# ------------------------------------------------------------- rank fusion


def row(rid: int, title: str = "관계 없는 제목", speakers: tuple = (), **extra) -> dict:
    """The default title deliberately shares nothing with any question below, so a
    fusion test measures fusion and not an accidental metadata boost."""
    return {"id": rid, "meeting_title": title, "speakers": list(speakers),
            "score": 0.5, **extra}


def test_fusion_promotes_what_both_axes_agree_on():
    """The point of RRF: agreement beats a single strong opinion."""
    both = row(1)
    dense_only = row(2)
    lexical_only = row(3)
    fused = fusion.fuse([dense_only, both], [lexical_only, both], "질문", 3, "hybrid")
    assert [r["id"] for r in fused][0] == 1


def test_a_chunk_dense_ranks_badly_can_still_reach_the_top():
    """The lexical-strong case: an exact term the embedding does not privilege."""
    target = row(99)
    dense = [row(i) for i in range(1, 20)] + [target]
    fused = fusion.fuse(dense, [target], "Redis 6379 포트", 5, "hybrid")
    assert fused[0]["id"] == 99


def test_a_paraphrase_only_dense_can_match_still_wins():
    """The dense-strong case: nothing lexical matches, so dense decides alone."""
    target = row(7)
    fused = fusion.fuse([target, row(8)], [], "돈이 얼마나 들어?", 5, "hybrid")
    assert fused[0]["id"] == 7


def test_dense_mode_is_the_ranking_this_application_had_before_fusion():
    dense = [row(1), row(2)]
    assert fusion.fuse(dense, [row(3)], "질문", 5, "dense") == dense


def test_lexical_mode_ignores_the_dense_axis():
    lex = [row(3)]
    assert fusion.fuse([row(1)], lex, "질문", 5, "lexical") == lex


def test_fusion_never_returns_more_than_top_k():
    rows = [row(i) for i in range(10)]
    assert len(fusion.fuse(rows, rows, "질문", 4, "hybrid+meta")) == 4


def test_the_fused_score_is_what_ordered_the_row():
    fused = fusion.fuse([row(1)], [row(1)], "질문", 1, "hybrid")
    assert fused[0]["score"] == round(2 / (fusion.RRF_K + 1), 6)


# ------------------------------------------------- metadata agreement, not guessing


def asked(question: str) -> set[str]:
    return set(lexical.tokens(question))


def test_a_speaker_counts_only_when_the_whole_name_was_typed():
    candidate = row(1, speakers=("최광훈",))
    assert fusion.meta_hits(candidate, asked("최광훈이 요청한 일이 뭐야?")) == 1
    assert fusion.meta_hits(candidate, asked("요청한 일이 뭐야?")) == 0


def test_a_partial_name_match_is_not_a_speaker_match():
    """"김 대리" must not be boosted by a question that only says 대리."""
    candidate = row(1, speakers=("김 대리",))
    assert fusion.meta_hits(candidate, asked("대리가 뭐라고 했어?")) == 0


def test_a_meeting_counts_only_when_the_question_names_most_of_its_title():
    candidate = row(1, title="보안 점검 회의")
    assert fusion.meta_hits(candidate, asked("보안 점검 회의에서 나온 결정이 뭐야?")) == 1


def test_one_shared_title_word_is_a_coincidence_and_not_a_meeting_match():
    """Measured regression: "월 350만원" matched every title containing 8월,
    and the boost then buried the meeting that actually said 350만원."""
    candidate = row(1, title="8월 1주차 개발 회의")
    assert fusion.meta_hits(candidate, asked("월 350만원")) == 0


def test_a_date_counts_only_when_both_the_month_and_the_day_were_typed():
    import datetime as dt

    held = {"meeting_at": dt.datetime(2026, 8, 19), "meeting_at_known": True}
    assert fusion.meta_hits(row(1, **held), asked("8월 19일 회의에서 뭐라고 했어?")) == 1
    assert fusion.meta_hits(row(1, **held), asked("8월에 뭐라고 했어?")) == 0


def test_a_registration_date_is_never_matched_as_the_meeting_date():
    """held_at NULL means nobody said when this happened. A question asking about
    a date must not be answered with an upload timestamp."""
    import datetime as dt

    registered = {"meeting_at": dt.datetime(2026, 8, 19), "meeting_at_known": False}
    assert fusion.meta_hits(row(1, **registered), asked("8월 19일 회의 내용")) == 0


def test_metadata_never_removes_a_candidate():
    rows = [row(i) for i in range(5)]
    plain = fusion.fuse(rows, rows, "관련 없는 질문", 5, "hybrid")
    boosted = fusion.fuse(rows, rows, "관련 없는 질문", 5, "hybrid+meta")
    assert {r["id"] for r in plain} == {r["id"] for r in boosted}


# --------------------------------------------------- grounding and citations


def test_a_citation_to_evidence_that_was_never_sent_is_removed():
    assert rag.validate_citations("담당자는 최광훈입니다[1]. 기한은 금요일입니다[9].", 2) == (
        "담당자는 최광훈입니다[1]. 기한은 금요일입니다."
    )


def test_every_valid_citation_is_left_exactly_as_it_was():
    answer = "배포는 금요일까지입니다[1][2]. 담당은 박서연입니다[3]."
    assert rag.validate_citations(answer, 3) == answer


def test_citation_validation_does_not_rewrite_the_claim():
    """Only the marker is dropped. Editing the sentence would be a second
    invention on top of the model's."""
    assert "담당자는 최광훈입니다" in rag.validate_citations("담당자는 최광훈입니다[7].", 1)


def test_two_meetings_naming_different_people_for_the_same_thing_is_a_conflict():
    assert rag.has_conflict([
        {"kind": "fact", "meeting_id": 1, "content": "2차 인증 도입을 맡는다",
         "participants": {"담당자": "김태호"}},
        {"kind": "fact", "meeting_id": 2, "content": "2차 인증 도입을 맡는다",
         "participants": {"담당자": "박서연"}},
    ])


def test_different_people_on_different_subjects_is_not_a_conflict():
    assert not rag.has_conflict([
        {"kind": "fact", "meeting_id": 1, "content": "2차 인증 도입을 맡는다",
         "participants": {"담당자": "김태호"}},
        {"kind": "fact", "meeting_id": 2, "content": "로그 보관 기간을 90일로 한다",
         "participants": {"담당자": "박서연"}},
    ])


def test_the_same_person_in_two_meetings_is_not_a_conflict():
    assert not rag.has_conflict([
        {"kind": "fact", "meeting_id": 1, "content": "SSL 인증서를 발급한다",
         "participants": {"담당자": "김태호"}},
        {"kind": "fact", "meeting_id": 2, "content": "SSL 인증서를 발급한다",
         "participants": {"담당자": "김태호"}},
    ])


def test_two_roles_in_one_meeting_are_not_a_conflict():
    """A request and the commitment that accepted it name two different people
    on purpose. That is the relationship, not a disagreement."""
    assert not rag.has_conflict([
        {"kind": "fact", "meeting_id": 1, "content": "현관 비밀번호를 남겨 달라는 요청",
         "participants": {"요청자": "화자 B"}},
        {"kind": "fact", "meeting_id": 1, "content": "현관 비밀번호를 문자로 전달",
         "participants": {"담당자": "화자 A"}},
    ])


def test_excerpts_alone_are_never_a_conflict():
    """Chunks carry no roles, so they cannot disagree about who is responsible."""
    assert not rag.has_conflict([{"kind": "chunk", "meeting_id": 1}, {"kind": "chunk", "meeting_id": 2}])


# ============================================================ database-backed

pytestmark_db = requires_db


def _msg(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class FakeOpenAI:
    """Plans with the question as typed; answers by echoing what it was shown."""

    calls: list = []

    def __init__(self, api_key=None):
        self.chat = SimpleNamespace(completions=self)

    def create(self, **kwargs):
        FakeOpenAI.calls.append(kwargs)
        if kwargs.get("response_format"):
            return _msg(json.dumps({
                "query": kwargs["messages"][-1]["content"],
                "fact_types": list(intelligence.FACT_TYPES),
                "participant_role": None,
                "self_reference": False,
            }))
        return _msg("근거 요약: " + kwargs["messages"][-1]["content"])


@pytest.fixture
def openai(monkeypatch):
    FakeOpenAI.calls = []
    monkeypatch.setattr(config, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    return FakeOpenAI


@pytest.fixture
def fact_of(fake_extract):
    """Factory: give an approved meeting exactly the facts a test names."""

    def make(meeting_id: int, facts: list[dict]):
        utterances, _ = pipeline.load_transcript(meeting_id)
        seg = [u["id"] for u in utterances]
        spk = {u["display_name"]: u["speaker_id"] for u in utterances}
        fake_extract["reply"] = json.dumps({"facts": [
            {**f,
             "source_segment_ids": [seg[i] for i in f["source_segment_ids"]],
             **{k: spk[v] for k, v in f.items() if k.endswith("_speaker_id")}}
            for f in facts
        ]})
        intelligence.build(meeting_id)
        return spk

    return make


REDIS_LINES = [
    ("SPEAKER_00", "캐시 서버 이야기를 하겠습니다."),
    ("SPEAKER_00", "Redis 캐시 서버는 6379 포트로 열어 두겠습니다."),
    ("SPEAKER_00", "모니터링은 다음에 논의하겠습니다."),
]


@requires_db
def test_indexing_writes_both_indexes_and_the_segments_a_chunk_came_from(make_meeting):
    """One statement writes the vector, the lexemes, and the provenance, so they
    cannot describe different revisions of the same text."""
    mid = make_meeting("인덱스 회의", REDIS_LINES)
    from app.db import conn

    with conn() as c:
        rows = c.execute(
            "SELECT content, lexemes, embedding IS NOT NULL AS vec, source_segment_ids,"
            " lexeme_tsv FROM chunks WHERE meeting_id = %s ORDER BY sequence",
            (mid,),
        ).fetchall()
        segments = {
            r["id"] for r in c.execute(
                "SELECT id FROM transcript_segments WHERE meeting_id = %s", (mid,)
            ).fetchall()
        }
    assert rows
    for r in rows:
        assert r["vec"] is True
        assert r["lexemes"] and "redis" in r["lexemes"]
        assert r["lexeme_tsv"]                      # the generated column followed
        assert set(r["source_segment_ids"]) <= segments
        assert r["source_segment_ids"]


@requires_db
def test_lexical_retrieval_finds_the_exact_term_that_was_said(make_meeting):
    mid = make_meeting("캐시 회의", REDIS_LINES)
    hits = rag.search_lexical("Redis 6379 포트", [mid])
    assert hits and all(h["meeting_id"] == mid for h in hits)
    assert "6379" in hits[0]["content"]


@requires_db
def test_a_question_with_no_lexemes_returns_nothing_rather_than_everything(make_meeting):
    make_meeting("캐시 회의", REDIS_LINES)
    assert rag.search_lexical("그거 언제까지야?") == []


@requires_db
def test_a_chunk_reaches_the_ui_with_the_segments_it_came_from(make_meeting):
    mid = make_meeting("캐시 회의", REDIS_LINES)
    sources = rag.serialize_sources(rag.search("Redis 포트", [mid]))
    assert sources and all(s["source_segment_ids"] for s in sources if s["kind"] == "chunk")


# --------------------------------------------------- the scope binds every path

SCOPE_FACT = [{
    "fact_type": "DECISION", "content": "Redis 캐시 서버를 6379 포트로 개방한다",
    "source_segment_ids": [1], "decider_speaker_id": "화자 A",
    "deadline_text": None, "status": "DONE",
}]


@pytest.fixture
def two_meetings(make_meeting, fact_of):
    inside = make_meeting("범위 안 회의", REDIS_LINES)
    outside = make_meeting("범위 밖 회의", REDIS_LINES)
    fact_of(inside, SCOPE_FACT)
    fact_of(outside, SCOPE_FACT)
    return inside, outside


@requires_db
@pytest.mark.parametrize("path", ["dense", "lexical", "fact_dense", "fact_lexical"])
def test_no_retrieval_path_reaches_a_meeting_outside_the_scope(two_meetings, path):
    """Four searches, one scope rule. A filter forgotten on one axis is a leak
    that the other axis's tests would never notice."""
    inside, outside = two_meetings
    question = "Redis 6379 포트"
    rows = {
        "dense": lambda: rag.search_dense(question, [inside]),
        "lexical": lambda: rag.search_lexical(question, [inside]),
        "fact_dense": lambda: intelligence.search_dense(question, [inside]),
        "fact_lexical": lambda: intelligence.search_lexical(question, [inside]),
    }[path]()
    assert rows, f"{path} found nothing, so it proves nothing about the scope"
    assert {r["meeting_id"] for r in rows} == {inside}
    assert outside not in {r["meeting_id"] for r in rows}


@requires_db
@pytest.mark.parametrize("mode", fusion.MODES)
def test_every_retrieval_mode_obeys_the_scope(two_meetings, mode):
    inside, outside = two_meetings
    sources = (
        rag.search("Redis 6379 포트", [inside], 6, mode)
        + intelligence.search("Redis 6379 포트", [inside], None, None, None, 6, mode)
    )
    assert sources
    assert {s["meeting_id"] for s in sources} == {inside}


@requires_db
def test_an_unapproved_meeting_is_lexically_invisible_too(make_meeting):
    """The approval gate is not a dense-retrieval feature."""
    draft = make_meeting("검토 대기 회의", REDIS_LINES, status="REVIEW_REQUIRED")
    assert rag.search_lexical("Redis 6379 포트") == [] or draft not in {
        r["meeting_id"] for r in rag.search_lexical("Redis 6379 포트")
    }


@requires_db
def test_the_scope_holds_through_the_chat_api_on_both_axes(client, two_meetings, openai):
    inside, outside = two_meetings
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [inside]}).json()["id"]
    body = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "Redis 6379 포트는 어떻게 하기로 했어?", "top_k": 12},
    ).json()
    assert body["sources"]
    assert {s["meeting_id"] for s in body["sources"]} == {inside}


# -------------------------------------------- lexical index maintenance


@requires_db
def test_the_backfill_builds_lexemes_without_touching_the_vectors(make_meeting):
    """Re-embedding and lexical reindexing are separate responsibilities: a
    meeting whose vectors are still valid must not have to pay for them again."""
    from app.db import conn

    from scripts import backfill_lexemes

    mid = make_meeting("보정 회의", REDIS_LINES)
    with conn() as c:
        before = c.execute(
            "SELECT id, embedding FROM chunks WHERE meeting_id = %s ORDER BY sequence",
            (mid,),
        ).fetchall()
        c.execute("UPDATE chunks SET lexemes = NULL WHERE meeting_id = %s", (mid,))

    written = backfill_lexemes.run()
    assert written["chunks"] >= len(before)

    with conn() as c:
        after = c.execute(
            "SELECT id, embedding, lexemes FROM chunks WHERE meeting_id = %s"
            " ORDER BY sequence",
            (mid,),
        ).fetchall()
    assert [r["lexemes"] for r in after] == [r["lexemes"] for r in after if r["lexemes"]]
    assert [list(r["embedding"]) for r in after] == [list(r["embedding"]) for r in before]


@requires_db
def test_the_backfill_is_idempotent(make_meeting):
    from scripts import backfill_lexemes

    make_meeting("보정 회의", REDIS_LINES)
    backfill_lexemes.run()
    assert backfill_lexemes.run() == {"chunks": 0, "meeting_facts": 0}


# ------------------------------------------------------- hybrid, end to end


@requires_db
def test_a_fact_is_findable_by_a_word_only_its_original_utterance_contains(
    make_meeting, fact_of
):
    """The fact's summary and the words that were said are both lexicalized, so a
    search for the exact spoken term reaches the structured row too."""
    mid = make_meeting("캐시 회의", REDIS_LINES)
    fact_of(mid, [{
        "fact_type": "DECISION", "content": "캐시 서버 포트를 개방한다",
        "source_segment_ids": [1], "decider_speaker_id": "화자 A",
        "deadline_text": None, "status": "DONE",
    }])
    hits = intelligence.search_lexical("6379", [mid])
    assert hits and "6379" in hits[0]["source_text"]


@requires_db
def test_a_conflict_between_two_meetings_reaches_the_model_as_both_answers(
    client, make_meeting, fact_of, openai
):
    """§20: two meetings, two different people, one question. The evidence must
    carry both and the prompt must say not to choose."""
    first = make_meeting("보안 점검 회의", [
        ("SPEAKER_00", "2차 인증 도입 담당은 김태호님이 맡아 주세요."),
        ("SPEAKER_01", "네, 제가 맡겠습니다."),
    ])
    second = make_meeting("QA 협의 회의", [
        ("SPEAKER_00", "2차 인증 도입은 제가 맡기로 했습니다."),
        ("SPEAKER_01", "알겠습니다."),
    ])
    fact_of(first, [{
        "fact_type": "ACTION_ITEM", "content": "2차 인증 도입을 맡는다",
        "source_segment_ids": [1], "assignee_speaker_id": "화자 B",
        "deadline_text": None, "status": "UNKNOWN",
    }])
    fact_of(second, [{
        "fact_type": "ACTION_ITEM", "content": "2차 인증 도입을 맡는다",
        "source_segment_ids": [0], "assignee_speaker_id": "화자 A",
        "deadline_text": None, "status": "UNKNOWN",
    }])

    sid = client.post(
        "/api/chat/sessions", json={"scope_meeting_ids": [first, second]}
    ).json()["id"]
    body = client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "2차 인증 도입은 누가 맡기로 했어?", "top_k": 12},
    ).json()

    facts = [s for s in body["sources"] if s["kind"] == "fact"]
    assert {s["meeting_id"] for s in facts} == {first, second}
    shown = [c for c in openai.calls if not c.get("response_format")][-1]
    evidence = shown["messages"][-1]["content"]
    assert "회의별로 나누어" in evidence
    # and the question is still the last thing the model reads
    assert evidence.rstrip().endswith("2차 인증 도입은 누가 맡기로 했어?")


@requires_db
def test_one_meeting_answering_one_way_gets_no_conflict_warning(
    client, make_meeting, fact_of, openai
):
    mid = make_meeting("보안 점검 회의", [
        ("SPEAKER_00", "2차 인증 도입 담당은 김태호님이 맡아 주세요."),
        ("SPEAKER_01", "네, 제가 맡겠습니다."),
    ])
    fact_of(mid, [{
        "fact_type": "ACTION_ITEM", "content": "2차 인증 도입을 맡는다",
        "source_segment_ids": [1], "assignee_speaker_id": "화자 B",
        "deadline_text": None, "status": "UNKNOWN",
    }])
    sid = client.post("/api/chat/sessions", json={"scope_meeting_ids": [mid]}).json()["id"]
    client.post(
        f"/api/chat/sessions/{sid}/messages",
        json={"question": "2차 인증 도입은 누가 맡기로 했어?"},
    )
    evidence = [c for c in openai.calls if not c.get("response_format")][-1]
    assert "회의별로 나누어" not in evidence["messages"][-1]["content"]
