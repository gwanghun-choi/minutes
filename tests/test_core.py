"""Minimal unit coverage for the logic that is not a model call."""
from app.services.chunking import build_chunks
from app.services.rag import _fmt_time, build_context, serialize_sources
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
