"""Utterance-aware chunking.

Chunks follow speaker turns, not a fixed character window: a chunk is a run of
consecutive utterances, capped by an approximate token budget and an utterance
count, with a small overlap so a question and its answer are never split apart.
"""

MAX_UTTERANCES = 7
TARGET_TOKENS = 320
MAX_TOKENS = 420
OVERLAP_UTTERANCES = 2


def approx_tokens(text: str) -> int:
    """Rough multilingual estimate: Korean runs ~1 token per 1.5 chars."""
    return max(1, int(len(text) / 1.5))


def _render(utterances: list[dict], names: dict[str, str]) -> str:
    return "\n".join(
        f"{names.get(u['speaker'], u['speaker'])}: {u['text']}" for u in utterances
    )


def build_chunks(utterances: list[dict], names: dict[str, str] | None = None) -> list[dict]:
    """utterances: [{start, end, text, speaker}] in time order."""
    names = names or {}
    chunks: list[dict] = []
    current: list[dict] = []
    tokens = 0
    fresh = 0  # utterances added since the last flush; carried overlap does not count

    def flush() -> None:
        nonlocal current, tokens, fresh
        if not current or not fresh:
            return
        chunks.append(
            {
                "sequence": len(chunks),
                "content": _render(current, names),
                "start_time": current[0]["start"],
                "end_time": current[-1]["end"],
                "speaker_codes": sorted({u["speaker"] for u in current}),
                # Provenance, not display: which approved utterances this text is.
                # `load_transcript` supplies the ids; a caller that builds
                # utterances by hand (a unit test) simply has none.
                "source_segment_ids": [u["id"] for u in current if u.get("id")],
            }
        )
        current = current[-OVERLAP_UTTERANCES:] if len(current) > OVERLAP_UTTERANCES else []
        tokens = sum(approx_tokens(u["text"]) for u in current)
        fresh = 0

    for utt in utterances:
        t = approx_tokens(utt["text"])
        if fresh and (len(current) >= MAX_UTTERANCES or tokens + t > MAX_TOKENS):
            flush()
        current.append(utt)
        tokens += t
        fresh += 1
        if tokens >= TARGET_TOKENS and fresh >= 2:
            flush()

    flush()
    return chunks
