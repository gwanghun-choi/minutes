"""pyannote speaker diarization -> [{start, end, speaker}]."""
from functools import lru_cache
from pathlib import Path

from app import config

MODEL_ID = "pyannote/speaker-diarization-community-1"


@lru_cache(maxsize=1)
def _pipeline():
    import torch
    from pyannote.audio import Pipeline

    pipe = Pipeline.from_pretrained(MODEL_ID, token=config.HF_TOKEN)
    if pipe is None:
        raise RuntimeError(
            f"Could not load {MODEL_ID}. Check HF_TOKEN and that the model "
            "licence has been accepted on huggingface.co."
        )
    device = config.resolve_device(config.WHISPER_DEVICE)
    if device == "cuda":
        pipe.to(torch.device("cuda"))
    return pipe


def diarize(wav_path: Path) -> list[dict]:
    annotation = _pipeline()(str(wav_path))
    if hasattr(annotation, "speaker_diarization"):  # community-1 returns a wrapper
        annotation = annotation.speaker_diarization
    return [
        {"start": float(turn.start), "end": float(turn.end), "speaker": str(label)}
        for turn, _, label in annotation.itertracks(yield_label=True)
    ]
