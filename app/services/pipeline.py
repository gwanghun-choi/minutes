"""Meeting processing, run as FastAPI background tasks.

Two phases, separated by an explicit human approval gate:

    process()          audio -> transcript, stops at REVIEW_REQUIRED
    index_transcript() approved transcript -> chunks + embeddings -> COMPLETED

Re-embedding an already-approved meeting is the same second phase run again; it
has no code of its own here.

An AI-generated transcript is a draft. Nothing here may create chunks or
embeddings until a human has approved the meeting.
"""
import logging
import traceback
from pathlib import Path

from app.db import conn
from app.services import audio, chunking, diarization, embedding, transcript, transcription

log = logging.getLogger("minutes.pipeline")


def set_status(meeting_id: int, status: str, error: str | None = None) -> None:
    with conn() as c:
        c.execute(
            "UPDATE meetings SET status = %s, error_message = %s WHERE id = %s",
            (status, error, meeting_id),
        )


def process(meeting_id: int, src_path: str) -> None:
    src = Path(src_path)
    try:
        set_status(meeting_id, "TRANSCRIBING")
        wav = audio.to_wav16k(src)
        duration = audio.duration_seconds(wav)
        stt, language = transcription.transcribe(wav)
        with conn() as c:
            c.execute(
                "UPDATE meetings SET duration = %s, language = %s WHERE id = %s",
                (duration, language, meeting_id),
            )
        if not stt:
            raise RuntimeError("STT 결과가 비어 있습니다. 음성이 인식되지 않았습니다.")

        set_status(meeting_id, "DIARIZING")
        warning = None
        try:
            turns = diarization.diarize(wav)
        except Exception as exc:
            log.exception("diarization failed, falling back to a single speaker")
            turns = []
            warning = f"화자 분리 실패({type(exc).__name__}). 전체를 단일 화자로 처리했습니다."
        utterances = transcript.assign_speakers(stt, turns)

        _persist_transcript(meeting_id, utterances)

        # HITL gate: the draft transcript is persisted and nothing else happens.
        # Chunking and embedding only run from index_transcript(), after a human
        # approves the meeting.
        set_status(meeting_id, "REVIEW_REQUIRED", warning)
    except Exception as exc:
        log.error("meeting %s failed: %s", meeting_id, traceback.format_exc())
        set_status(meeting_id, "FAILED", f"{type(exc).__name__}: {exc}"[:1000])


def load_transcript(meeting_id: int) -> tuple[list[dict], dict[str, str]]:
    """Read the meeting's current (possibly human-edited) transcript.

    -> ([{id, sequence, start, end, text, speaker, speaker_id, display_name}]
        in sequence order, {speaker_code: display_name})

    This is the source of truth for indexing, summarizing, and fact extraction —
    the only transcript reader in the application. Never index the in-memory
    draft the analysis phase produced: a reviewer may have corrected it since.

    Chunking reads start/end/text/speaker; fact extraction additionally needs the
    row ids, because a fact must cite the segments it came from.
    """
    with conn() as c:
        rows = c.execute(
            "SELECT t.id, t.sequence, t.start_time, t.end_time, t.text,"
            " t.speaker_id, s.speaker_code, s.display_name"
            " FROM transcript_segments t"
            " LEFT JOIN speakers s ON s.id = t.speaker_id"
            " WHERE t.meeting_id = %s ORDER BY t.sequence",
            (meeting_id,),
        ).fetchall()
    utterances = [
        {
            "id": r["id"],
            "sequence": r["sequence"],
            "start": r["start_time"],
            "end": r["end_time"],
            "text": r["text"],
            "speaker": r["speaker_code"] or "SPEAKER_00",
            "speaker_id": r["speaker_id"],
            "display_name": r["display_name"] or r["speaker_code"] or "SPEAKER_00",
        }
        for r in rows
    ]
    names = {
        r["speaker_code"]: r["display_name"]
        for r in rows
        if r["speaker_code"] and r["display_name"]
    }
    return utterances, names


def index_transcript(meeting_id: int, on_failure: str = "REVIEW_REQUIRED") -> None:
    """Chunk, embed, and store the approved transcript. Ends at COMPLETED.

    Only ever called after a caller has atomically moved the meeting into
    INDEXING (see api/meetings.py:_claim_for_indexing), which is what makes a
    double request a no-op rather than a duplicate index.

    `on_failure` is where a failed run lands, and it differs by caller because
    what survives a failure differs. After an approval there is no index yet, so
    the meeting goes back to REVIEW_REQUIRED for the reviewer to retry. A
    re-embed starts from a meeting that already has a usable index, and nothing
    deleted it — embedding runs before the transaction, and the delete and the
    inserts share it — so the meeting returns to COMPLETED, still searchable
    exactly as it was.
    """
    try:
        utterances, names = load_transcript(meeting_id)
        chunks = chunking.build_chunks(utterances, names)
        vectors = embedding.encode([c["content"] for c in chunks]) if chunks else []
        with conn() as c:
            # Replace rather than append: re-indexing must not duplicate chunks.
            c.execute("DELETE FROM chunks WHERE meeting_id = %s", (meeting_id,))
            for ch, vec in zip(chunks, vectors):
                c.execute(
                    "INSERT INTO chunks (meeting_id, sequence, content, start_time, end_time,"
                    " speaker_codes, embedding) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (meeting_id, ch["sequence"], ch["content"], ch["start_time"],
                     ch["end_time"], ch["speaker_codes"], vec),
                )
        set_status(meeting_id, "COMPLETED")
    except Exception as exc:
        # The transcript is untouched and still in the database, and so is any
        # index the meeting already had. Land on the caller's fallback status.
        log.error("meeting %s indexing failed: %s", meeting_id, traceback.format_exc())
        retry = (
            "수정 후 다시 승인해 주세요."
            if on_failure == "REVIEW_REQUIRED"
            else "기존 검색 인덱스는 그대로 유지됩니다."
        )
        set_status(
            meeting_id,
            on_failure,
            f"인덱싱 실패({type(exc).__name__}: {exc}). 회의록은 보존되었습니다. {retry}"[:1000],
        )


def _persist_transcript(meeting_id: int, utterances: list[dict]) -> None:
    """Write the draft transcript. Speakers are upserted so a reviewer's
    display_name survives; segments are rewritten."""
    codes = sorted({u["speaker"] for u in utterances})
    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    with conn() as c:
        c.execute("DELETE FROM transcript_segments WHERE meeting_id = %s", (meeting_id,))
        ids = {}
        for i, code in enumerate(codes):
            # DO UPDATE (not DO NOTHING) so the row is returned either way; the
            # assignment is a no-op and leaves any existing display_name intact.
            row = c.execute(
                "INSERT INTO speakers (meeting_id, speaker_code, display_name)"
                " VALUES (%s,%s,%s)"
                " ON CONFLICT (meeting_id, speaker_code)"
                " DO UPDATE SET speaker_code = EXCLUDED.speaker_code"
                " RETURNING id",
                (meeting_id, code, f"화자 {labels[i] if i < 26 else i}"),
            ).fetchone()
            ids[code] = row["id"]
        for seq, u in enumerate(utterances):
            c.execute(
                "INSERT INTO transcript_segments (meeting_id, speaker_id, sequence,"
                " start_time, end_time, text) VALUES (%s,%s,%s,%s,%s,%s)",
                (meeting_id, ids[u["speaker"]], seq, u["start"], u["end"], u["text"]),
            )
