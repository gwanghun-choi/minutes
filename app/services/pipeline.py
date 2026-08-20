"""End-to-end meeting processing, run as a FastAPI background task."""
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

        names = _persist_transcript(meeting_id, utterances)

        set_status(meeting_id, "INDEXING")
        chunks = chunking.build_chunks(utterances, names)
        vectors = embedding.encode([c["content"] for c in chunks]) if chunks else []
        with conn() as c:
            c.execute("DELETE FROM chunks WHERE meeting_id = %s", (meeting_id,))
            for ch, vec in zip(chunks, vectors):
                c.execute(
                    "INSERT INTO chunks (meeting_id, sequence, content, start_time, end_time,"
                    " speaker_codes, embedding) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (meeting_id, ch["sequence"], ch["content"], ch["start_time"],
                     ch["end_time"], ch["speaker_codes"], vec),
                )
        set_status(meeting_id, "COMPLETED", warning)
    except Exception as exc:
        log.error("meeting %s failed: %s", meeting_id, traceback.format_exc())
        set_status(meeting_id, "FAILED", f"{type(exc).__name__}: {exc}"[:1000])


def _persist_transcript(meeting_id: int, utterances: list[dict]) -> dict[str, str]:
    """Rewrites speakers + segments for the meeting. -> {speaker_code: display_name}"""
    codes = sorted({u["speaker"] for u in utterances})
    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    names: dict[str, str] = {}
    with conn() as c:
        c.execute("DELETE FROM transcript_segments WHERE meeting_id = %s", (meeting_id,))
        c.execute("DELETE FROM speakers WHERE meeting_id = %s", (meeting_id,))
        ids = {}
        for i, code in enumerate(codes):
            names[code] = f"화자 {labels[i] if i < 26 else i}"
            row = c.execute(
                "INSERT INTO speakers (meeting_id, speaker_code, display_name) "
                "VALUES (%s,%s,%s) RETURNING id",
                (meeting_id, code, names[code]),
            ).fetchone()
            ids[code] = row["id"]
        for seq, u in enumerate(utterances):
            c.execute(
                "INSERT INTO transcript_segments (meeting_id, speaker_id, sequence,"
                " start_time, end_time, text) VALUES (%s,%s,%s,%s,%s,%s)",
                (meeting_id, ids[u["speaker"]], seq, u["start"], u["end"], u["text"]),
            )
    return names
