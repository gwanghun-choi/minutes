"""Merge the STT timeline with the diarization timeline."""


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def assign_speakers(
    stt_segments: list[dict], turns: list[dict], default: str = "SPEAKER_00"
) -> list[dict]:
    """Give every STT segment the speaker it overlaps with the most.

    ponytail: single best-overlap label per segment. A segment spanning a
    speaker change keeps one label; splitting it would need word timestamps.
    """
    out = []
    for seg in stt_segments:
        totals: dict[str, float] = {}
        for turn in turns:
            ov = _overlap(seg["start"], seg["end"], turn["start"], turn["end"])
            if ov > 0:
                totals[turn["speaker"]] = totals.get(turn["speaker"], 0.0) + ov
        speaker = max(totals, key=totals.get) if totals else default
        out.append({**seg, "speaker": speaker})
    return out
