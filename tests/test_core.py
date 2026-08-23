"""Minimal unit coverage for the logic that is not a model call."""
from app.services.chunking import build_chunks
from app.services.rag import (
    LLM_FAILED_PREFIX, NO_KEY_ANSWER, _fmt_time, build_context, cited_sources,
    is_self_scoped, serialize_sources,
)
from app.services.transcript import assign_speakers


def _utt(start, end, text, speaker="SPEAKER_00", seg=None):
    utt = {"start": start, "end": end, "text": text, "speaker": speaker}
    return utt | {"id": seg} if seg is not None else utt


def test_assign_speakers_picks_max_overlap():
    stt = [{"start": 0.0, "end": 5.0, "text": "안녕하세요"}]
    turns = [
        {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"},
        {"start": 1.0, "end": 5.0, "speaker": "SPEAKER_01"},
    ]
    assert assign_speakers(stt, turns)[0]["speaker"] == "SPEAKER_01"


def test_assign_speakers_falls_back_when_no_diarization():
    stt = [{"start": 0.0, "end": 2.0, "text": "네"}]
    assert assign_speakers(stt, [])[0]["speaker"] == "SPEAKER_00"


def test_chunks_are_utterance_aligned_and_cover_the_timeline():
    utts = [
        _utt(i * 3.0, i * 3.0 + 2.5, f"문장 {i} " * 12, f"SPEAKER_0{i % 2}")
        for i in range(20)
    ]
    chunks = build_chunks(utts)
    assert len(chunks) > 1
    # never split mid-utterance: every boundary is an utterance boundary
    starts = {u["start"] for u in utts}
    ends = {u["end"] for u in utts}
    assert all(c["start_time"] in starts and c["end_time"] in ends for c in chunks)
    assert chunks[0]["start_time"] == utts[0]["start"]
    assert chunks[-1]["end_time"] == utts[-1]["end"]
    # consecutive chunks overlap, so a question and its answer stay together
    assert chunks[1]["start_time"] < chunks[0]["end_time"]
    assert [c["sequence"] for c in chunks] == list(range(len(chunks)))


def test_chunk_keeps_speaker_labels_in_content():
    chunks = build_chunks(
        [_utt(0, 1, "일정은?", "SPEAKER_00"), _utt(1, 2, "금요일입니다", "SPEAKER_01")],
        {"SPEAKER_00": "화자 A", "SPEAKER_01": "화자 B"},
    )
    assert chunks[0]["content"] == "화자 A: 일정은?\n화자 B: 금요일입니다"
    assert chunks[0]["speaker_codes"] == ["SPEAKER_00", "SPEAKER_01"]


def test_source_serialization_carries_the_evidence_fields():
    rows = [
        {
            "id": 7, "meeting_id": 3, "meeting_title": "주간 회의",
            "content": "화자 A: 금요일까지", "start_time": 65.0, "end_time": 92.5,
            "speakers": ["화자 A"], "score": 0.83,
        }
    ]
    (s,) = serialize_sources(rows)
    assert (s["index"], s["meeting_id"], s["meeting_title"]) == (1, 3, "주간 회의")
    assert s["speakers"] == ["화자 A"] and s["time_label"] == "01:05 ~ 01:32"
    assert s["text"] == "화자 A: 금요일까지"
    assert "[1] 회의: 주간 회의" in build_context(rows)


def test_fmt_time():
    assert _fmt_time(0) == "00:00" and _fmt_time(3661) == "61:01"


def test_a_chunk_names_the_segments_it_was_built_from():
    """Provenance for an excerpt: the chunk has to be able to say which approved
    utterances it is, not only which meeting and which seconds."""
    utts = [_utt(i * 3.0, i * 3.0 + 2.5, f"문장 {i} " * 12, seg=100 + i) for i in range(20)]
    chunks = build_chunks(utts)
    assert all(c["source_segment_ids"] for c in chunks)
    # every id is a real utterance, and the range matches the time range
    for c in chunks:
        ids = c["source_segment_ids"]
        assert ids == sorted(ids)
        assert utts[ids[0] - 100]["start"] == c["start_time"]
        assert utts[ids[-1] - 100]["end"] == c["end_time"]
    # together they cover the whole transcript
    assert {i for c in chunks for i in c["source_segment_ids"]} == {u["id"] for u in utts}


def test_a_hand_built_utterance_with_no_id_simply_has_no_provenance():
    """`build_chunks` is also called from unit tests and from the analysis phase
    with utterances that have no row yet. That is an empty list, not a crash."""
    chunks = build_chunks([_utt(0.0, 2.0, "안녕하세요")])
    assert chunks[0]["source_segment_ids"] == []


# ---------------------------------------------------------- self-scoped questions
#
# The gate that can refuse to search at all, so it is decided here and not by the
# planner LLM. A general question that was classified as self-scoped came back as
# "[나로 지정]을 먼저 눌러 주세요" and answered normally on the next attempt.

GENERAL_QUESTIONS = [
    "이 통화에서 결정된 내용 정리해줘.",
    "이번 회의에서 누가 담당하기로 했어?",
    "이 회의에서 해야 할 일이 뭐야?",
    "회의 내용 요약해줘.",
    "결제 프로세스는 어떻게 되나요?",          # "결제"의 제
    "안내 사항이 뭐였어?",                     # "안내"의 내
    "내용을 정리해줘.",                        # "내용"의 내
    "곰팡이 제거 추가금은 누가 연락하기로 했어?",
]

SELF_QUESTIONS = [
    "내가 요청한 게 뭐야?",
    "내가 맡은 일이 뭐야?",
    "내가 결정한 내용 알려줘.",
    "내가 언제까지 하기로 했어?",
    "제가 요청한 것 알려줘.",
    "나한테 요청된 일이 뭐야?",
    "내 담당 업무 알려줘.",
    "제 기한이 언제야?",
]


def test_a_general_question_is_not_self_scoped():
    assert [q for q in GENERAL_QUESTIONS if is_self_scoped(q)] == []


def test_an_explicit_first_person_question_is_self_scoped():
    assert [q for q in SELF_QUESTIONS if not is_self_scoped(q)] == []


def test_the_same_question_is_judged_the_same_way_every_time():
    """The bug the UAT saw was a judgement that changed between two identical
    requests. Nothing here depends on a model, so it cannot."""
    question = "이 통화에서 결정된 내용 정리해줘."
    assert {is_self_scoped(question) for _ in range(20)} == {False}


# ---------------------------------------------------------------- 출처

# Six retrieved candidates, numbered the way `serialize_sources` numbers them.
SIX = [{"index": i, "text": f"근거 {i}"} for i in range(1, 7)]


def test_only_the_evidence_the_answer_cited_is_public():
    """Retrieval sends Top-K; the answer rests on the ones it named.

    "출처 6개" under an answer quoting two describes the search, not the answer.
    """
    shown = cited_sources("구매부는 병원별로, 재무지원실은 매입처별로 [1] [2]", SIX)
    assert [s["index"] for s in shown] == [1, 2]


def test_the_same_citation_twice_is_one_source():
    shown = cited_sources("먼저 [3], 그리고 다시 [3] 에서 확인됩니다.", SIX)
    assert [s["index"] for s in shown] == [3]


def test_cited_sources_keep_their_retrieval_order_and_their_numbers():
    """The [5] in the prose has to name the card labelled [5], so nothing is
    renumbered and the order is retrieval's, not the order they were cited in."""
    shown = cited_sources("[5] 이후 [2] 로 바뀌었습니다.", SIX)
    assert [s["index"] for s in shown] == [2, 5]


def test_an_answer_that_cites_nothing_has_no_public_evidence():
    assert cited_sources("회의록에서 해당 내용을 찾지 못했습니다.", SIX) == []


def test_a_citation_outside_the_evidence_resolves_to_nothing():
    """`validate_citations` removes these upstream; a stored message from an
    older build may still carry one, and it must not invent a card."""
    assert cited_sources("확인했습니다. [9]", SIX) == []


def test_an_answer_the_application_wrote_itself_keeps_all_its_evidence():
    """Both fallbacks say "아래 검색된 근거를 참고하세요" and cite nothing. For
    them the retrieved set *is* the answer, so filtering must not empty it."""
    assert cited_sources(NO_KEY_ANSWER, SIX) == SIX
    assert cited_sources(f"{LLM_FAILED_PREFIX} (RuntimeError). 아래 …", SIX) == SIX
