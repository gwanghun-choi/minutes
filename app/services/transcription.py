"""faster-whisper STT. Model is loaded once and reused."""
from functools import lru_cache
from pathlib import Path

from faster_whisper import WhisperModel

from app import config


@lru_cache(maxsize=1)
def _model() -> WhisperModel:
    device = config.resolve_device(config.WHISPER_DEVICE)
    compute = config.WHISPER_COMPUTE_TYPE
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    return WhisperModel(config.WHISPER_MODEL, device=device, compute_type=compute)


def transcribe(wav_path: Path) -> tuple[list[dict], str]:
    """-> ([{start, end, text}], detected_language)"""
    segments, info = _model().transcribe(
        str(wav_path),
        language=config.WHISPER_LANGUAGE,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
    )
    out = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.append({"start": float(seg.start), "end": float(seg.end), "text": text})
    return out, info.language
