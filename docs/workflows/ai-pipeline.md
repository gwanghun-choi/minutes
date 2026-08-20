# AI pipeline

Each stage as implemented, as of 2026-08-20. Orchestrated top to bottom by
`app/services/pipeline.py:process`, which is the only caller of these stages.

Responsibilities must not blur — see "AI model responsibilities" in
[AGENTS.md](../../AGENTS.md).

---

## 1. Audio normalization

| | |
|---|---|
| **Responsibility** | Convert any accepted upload to the one format every model consumes. |
| **Input** | Uploaded file at `UPLOAD_DIR/<uuid>.<ext>`; extension already validated against `config.ALLOWED_EXT`. |
| **Output** | `<uuid>.16k.wav` — 16 kHz, mono, no video stream — beside the original. |
| **Implementation** | `app/services/audio.py:to_wav16k`. FFmpeg subprocess; binary from `shutil.which("ffmpeg")` or the `imageio-ffmpeg` static build. Returns the existing file if already converted. |
| **Failure** | `check=True` raises → meeting `FAILED`. |

`duration_seconds()` parses the last `time=` line of FFmpeg's stderr; if it
cannot, it returns `0.0` and the meeting continues.

## 2. Speech-to-text

| | |
|---|---|
| **Responsibility** | Text with segment timestamps, and language detection. Nothing about speakers. |
| **Input** | The 16 kHz WAV. |
| **Output** | `[{start, end, text}]` and a detected language code. |
| **Implementation** | `app/services/transcription.py`. faster-whisper, model from `WHISPER_MODEL` (default `medium`), device from `WHISPER_DEVICE` (`auto` → CUDA only if a usable runtime exists, else CPU), compute type `auto` → `float16` on CUDA, `int8` on CPU. VAD filter on, `min_silence_duration_ms=500`, `beam_size=5`. Empty-text segments dropped. Model cached with `lru_cache`. |
| **Failure** | An empty segment list raises explicitly → meeting `FAILED`. |

## 3. Speaker diarization

| | |
|---|---|
| **Responsibility** | Who spoke when. Produces no text. |
| **Input** | The same 16 kHz WAV. Independent of stage 2. |
| **Output** | `[{start, end, speaker}]` with anonymous labels `SPEAKER_00`, `SPEAKER_01`, … |
| **Implementation** | `app/services/diarization.py`. `pyannote/speaker-diarization-community-1` via `Pipeline.from_pretrained`, authenticated with `HF_TOKEN`. Moved to CUDA when the resolved device is CUDA. The community-1 result is unwrapped via its `speaker_diarization` attribute. Pipeline cached with `lru_cache`. |
| **Failure** | Caught in `pipeline.process`: turns become `[]`, a warning string is recorded, and the run continues. Every segment then falls back to `SPEAKER_00`, so the meeting completes as single-speaker. |

The model is gated on Hugging Face. Without an accepting token, this stage always
takes the fallback path — see "Known limitations" in [AGENTS.md](../../AGENTS.md).

## 4. Alignment

| | |
|---|---|
| **Responsibility** | Join the two independent timelines into utterances. |
| **Input** | STT segments and diarization turns. |
| **Output** | `[{start, end, text, speaker}]`. |
| **Implementation** | `app/services/transcript.py:assign_speakers`. For each STT segment, sum the overlap with every turn per speaker, take the maximum. No overlap at all → `default` (`SPEAKER_00`). |
| **Failure** | Pure function, no I/O. Cannot fail on its own. |

One speaker per segment. A segment spanning a speaker change is attributed
wholly to the dominant speaker; splitting would require word-level timestamps.
Marked with a `ponytail:` comment at the call site.

## 5. Transcript persistence

| | |
|---|---|
| **Responsibility** | Store utterances and establish the meeting's speaker set. |
| **Input** | Aligned utterances. |
| **Output** | Rows in `speakers` and `transcript_segments`; returns `{speaker_code: display_name}`. |
| **Implementation** | `app/services/pipeline.py:_persist_transcript`. Deletes both tables' rows for the meeting, then inserts. Display names are assigned by sorted `speaker_code` order: `화자 A`, `화자 B`, … |
| **Failure** | Propagates → meeting `FAILED`. |

Because this rewrites rows, re-running the pipeline discards user-edited display
names.

## 6. Chunking

| | |
|---|---|
| **Responsibility** | Group utterances into retrieval units without cutting inside an utterance. |
| **Input** | Aligned utterances plus the display-name map. |
| **Output** | `[{sequence, content, start_time, end_time, speaker_codes}]`. |
| **Implementation** | `app/services/chunking.py:build_chunks`. Constants: `MAX_UTTERANCES=7`, `TARGET_TOKENS=320`, `MAX_TOKENS=420`, `OVERLAP_UTTERANCES=2`. Token count is estimated as `len(text)/1.5` — a Korean-oriented approximation, not a real tokenizer. A chunk flushes when the utterance cap or `MAX_TOKENS` would be exceeded, or once `TARGET_TOKENS` is reached with at least 2 fresh utterances. The last 2 utterances carry into the next chunk as overlap; a `fresh` counter ensures carried-over utterances alone never emit a chunk. Content renders as `화자 A: …` lines. |
| **Failure** | Pure function. Empty input yields no chunks, and the meeting still completes. |

No morphological analyzer is used, deliberately: BGE-M3 has its own subword
tokenizer, and pre-segmenting would distort its input distribution.

Changing any constant here invalidates the meaning of every stored vector.

## 7. Embedding

| | |
|---|---|
| **Responsibility** | Turn chunk text and query text into comparable vectors. |
| **Input** | Chunk contents (batch) or one query string. |
| **Output** | L2-normalized float vectors, 1024-dim with the default model. |
| **Implementation** | `app/services/embedding.py`. sentence-transformers, `EMBEDDING_MODEL` (default `BAAI/bge-m3`), device resolved the same way as Whisper, `batch_size=8`, `normalize_embeddings=True`. Model and dimension both cached with `lru_cache`. |
| **Failure** | Propagates → meeting `FAILED` during indexing; raises at startup if the model cannot load. |

`dimension()` is authoritative: `app/main.py` passes it to `db.apply_schema`,
which refuses to start when the existing column disagrees.

## 8. Retrieval

| | |
|---|---|
| **Responsibility** | Find the chunks most likely to contain the answer, with their provenance. |
| **Input** | Question, optional `meeting_id`, `top_k` (clamped to 1–12 in `app/api/chat.py`). |
| **Output** | Chunk rows plus `meeting_title`, resolved `speakers`, and a cosine `score`. |
| **Implementation** | `app/services/rag.py:search`. `ORDER BY embedding <=> query` (cosine distance) with `LIMIT`, joined to `meetings`; `WHERE embedding IS NOT NULL`; optional `meeting_id` filter gives whole-corpus vs single-meeting scope. A second query resolves `speaker_codes` to display names per meeting. Score is reported as `1 - distance`. |
| **Failure** | No rows → `answer()` returns the "not found" message with an empty source list and makes no LLM call. |

Dense vectors only. No lexical, keyword, or hybrid search.

## 9. Answer generation

| | |
|---|---|
| **Responsibility** | Compose an answer *from the retrieved evidence only*. It is not a retrieval step and not a source of facts. |
| **Input** | Numbered evidence blocks from `build_context` (meeting title, time range, speakers, chunk text) plus the question. |
| **Output** | `{answer, sources[]}`; sources shaped by `serialize_sources`. |
| **Implementation** | `app/services/rag.py:answer`. OpenAI Chat Completions, `OPENAI_MODEL` (default `gpt-4o-mini`), `temperature=0`. The system prompt forbids inventing anything outside the evidence, requires "회의록에서 해당 내용을 찾지 못했습니다." when the evidence does not answer, and asks for `[1]`-style citations. |
| **Failure** | No API key → evidence returned with an explanatory answer, no call made. Call raises → caught and logged, evidence still returned. Retrieval success and generation success are reported independently. |

Provenance fields are a contract; see "RAG / provenance invariant" in
[AGENTS.md](../../AGENTS.md).

---

## Planned follow-up

Not implemented. Do not describe as current behaviour.

- **HITL Transcript Review Gate** — a human review step between stage 5
  (transcript persistence) and stage 6 (chunking), so that only reviewed
  transcripts are indexed. Today stages 1–8 run without a pause, and a meeting
  reaching `COMPLETED` means it is already indexed.
