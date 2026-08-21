# AI pipeline

Each stage as implemented, as of 2026-08-21. Stages 1–5 run in
`app/services/pipeline.py:process`; stages 6–7 run in
`app/services/pipeline.py:index_transcript`, which a human approval starts —
or, for a meeting already approved, a re-embed (see 5a). Stage 7a runs after
that, as its own background task. Stages 8–9 serve queries.

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
| **Failure** | Caught in `pipeline.process`: turns become `[]`, a warning string is recorded, and the run continues. Every segment falls back to `SPEAKER_00`. The reviewer can reassign speakers at the gate before approving. |

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
| **Output** | Rows in `speakers` and `transcript_segments`. |
| **Implementation** | `app/services/pipeline.py:_persist_transcript`. Rewrites `transcript_segments`; **upserts** `speakers` on `(meeting_id, speaker_code)` so an existing `display_name` is left intact. New names are assigned by sorted `speaker_code` order: `화자 A`, `화자 B`, … |
| **Failure** | Propagates → meeting `FAILED`. |

The analysis phase ends here. `process` sets `REVIEW_REQUIRED` and returns.

## 5a. Human approval gate

| | |
|---|---|
| **Responsibility** | Hold the draft until a human accepts it. Nothing downstream may run before this passes. |
| **Input** | A meeting at `REVIEW_REQUIRED` and a reviewer. |
| **Output** | The meeting moves to `INDEXING`, and `index_transcript` is scheduled. |
| **Implementation** | `PATCH /api/meetings/{id}/transcript` saves segment text and speaker reassignment; `PATCH /api/meetings/{id}/speakers/{sid}` renames a speaker (also gated to the review state); `POST /api/meetings/{id}/approve` performs an atomic `UPDATE … WHERE status = 'REVIEW_REQUIRED'` and schedules indexing. Edits are rejected outside `REVIEW_REQUIRED`. |
| **Failure** | Approval in any other state → `409`, no indexing. A repeated approval matches no row → `409`, so it cannot index twice. An edit holds `SELECT … FOR UPDATE` on the meeting row, so it cannot interleave with an approval. |

This is the invariant the whole gate exists for: **an AI transcript is a draft
until a human approves it.** See
[the decision record](../decisions/2026-08-20-hitl-transcript-review-gate.md).

**Re-embedding.** `POST /api/meetings/{id}/reindex` runs stages 6–7 again on an
already-approved meeting, claiming it with the same compare-and-set from
`COMPLETED` instead of `REVIEW_REQUIRED`. Stages 1–5 do not run: no audio is
read, and `transcript_segments` and `speakers` are not rewritten. It exists so a
change to the chunking constants or the embedding model can be applied to
existing meetings without a re-upload. A failure returns the meeting to
`COMPLETED` with the previous index intact.

## 6. Chunking

| | |
|---|---|
| **Responsibility** | Group utterances into retrieval units without cutting inside an utterance. |
| **Input** | The approved transcript, re-read from the database by `pipeline.load_transcript` — never the in-memory draft, which may be out of date by the time a reviewer approves. |
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
| **Failure** | Caught by `index_transcript` → the meeting returns to `REVIEW_REQUIRED` with the error recorded; raises at startup if the model cannot load. |

`dimension()` is authoritative at startup: `app/main.py` passes it to
`migrate.verify`, which refuses to start when the existing column disagrees. The
column itself is fixed by migration `001` at `vector(1024)`; changing the model
means a new migration and re-embedding every row.

## 7a. Fact extraction (Meeting Intelligence)

| | |
|---|---|
| **Responsibility** | Turn the approved transcript into structured facts — requests, decisions, action items — with the people, deadlines, and source segments behind them. |
| **What each type is** | `REQUEST`: somebody asks somebody else to do something. `DECISION`: something the meeting settled. `ACTION_ITEM`: **the speaker's own explicit promise or acceptance to do something** ("문자로 남겨드리겠습니다", "네, 제가 맡겠습니다") — its `ASSIGNEE` is the speaker of that utterance. A request and the acceptance answering it are two facts with two different sources; neither replaces the other, and neither is derived from the other. Plain agreement, a past action, and a possibility are not action items. |
| **Input** | `pipeline.load_transcript`, the same reader indexing and summarizing use, in windows of `WINDOW_SEGMENTS` (40) with `OVERLAP_SEGMENTS` (5). Every line is rendered with its own `segment=`, `speaker=`, `name=`, `start=`, `end=`, so the model cannot invent an id. |
| **Output** | `meeting_facts` rows plus `meeting_fact_participants`, and `meetings.intelligence_state = READY`. |
| **Implementation** | `app/services/intelligence.py:build`. OpenAI JSON mode per window, then `_validate`: unknown fact type or empty content → dropped; a segment id this meeting does not have → dropped, and a fact with no source left → dropped with it; a speaker that is not this meeting's → the role is dropped, the fact is kept; `deadline_text` is stored as spoken and `deadline_at` is computed by `deadline_date` in Python against `coalesce(held_at, created_at)`, never by the model, and only when the year, month, and day are all pinned; any `status` the meeting did not explicitly state becomes `UNKNOWN`, never `OPEN`. `_dedupe` then removes what two overlapping windows both saw. Facts are embedded with the same BGE-M3 model at the same 1024 dims, over a canonical text that includes the role and deadline labels. |
| **Ordering** | Everything is extracted and embedded **before** the delete. The `DELETE` and the `INSERT`s share one transaction, so a failure leaves the previous facts untouched. |
| **Trigger** | `intelligence.after_approval`, queued as a second background task by `POST /approve` — it runs after indexing and only claims a meeting that actually reached `COMPLETED`. Also `POST /api/meetings/{id}/intelligence/rebuild`. A re-embed does **not** rebuild facts. |
| **Failure** | Caught in `run_build` → `intelligence_state = FAILED` with the message. `meetings.status` is never touched: an approved meeting stays approved, indexed, and searchable. Without `OPENAI_API_KEY` nothing is attempted and the state stays `NOT_BUILT`. |

Stage 7a is the only stage whose failure is not visible in `meetings.status`,
and that is deliberate — see "Failure behaviour" in
[docs/architecture/current.md](../architecture/current.md#failure-behaviour).

## 7b. Query planning

| | |
|---|---|
| **Responsibility** | Turn a conversational question into one standalone search query and say which facts to filter for. It is a **retrieval aid**, never an answer. |
| **Input** | The question plus the same prior turns the generator sees. |
| **Output** | `{query, fact_types, participant_role, self_reference}`. |
| **Implementation** | `app/services/rag.py:plan`. One OpenAI JSON call. `fact_types` and `participant_role` are validated against the enums in `intelligence.py` and never interpolated into SQL as identifiers. |
| **Failure** | No key, unparseable JSON, or an unknown enum value → the question as typed, all fact types, no role, no self filter. That is the dense-retrieval behaviour this had before, so a planner outage degrades rather than breaks. |

The rewritten query is used for retrieval only. The generator always receives the
question exactly as the user typed it, and a rewrite never changes the scope.

## 8. Retrieval

| | |
|---|---|
| **Responsibility** | Find the evidence most likely to contain the answer, with its provenance. Two layers, one scope rule. |
| **Input** | The planned query, optional `meeting_ids` (the chat scope), `top_k` (clamped to 1–12 in `app/api/chat.py`), and the plan's fact filters. |
| **Output** | Fact rows first, then chunk rows; both carry `meeting_title`, `speakers`, times, and a cosine `score`. |
| **Structured** | `app/services/intelligence.py:search` over `meeting_facts`. Same `m.status = 'COMPLETED'` and `meeting_id = ANY(...)` predicates as below, plus an `EXISTS` on `meeting_fact_participants` for the role and, for a "내가" question, for this account's own speaker ids from `meeting_user_speakers`. Retrieved by cosine, then **re-sorted by `(coalesce(meetings.held_at, meetings.created_at), start_time)`** so a "how did this change" question reads its evidence as a timeline of when the meetings were held. A meeting with no `held_at` still sorts, on its upload date, and its rendered date is labelled `등록`. |
| **Dense** | `app/services/rag.py:search`. `ORDER BY embedding <=> query` (cosine distance) with `LIMIT`, joined to `meetings`; `WHERE embedding IS NOT NULL AND m.status = 'COMPLETED'`; an optional `c.meeting_id = ANY(...)` filter applies the chat scope — empty or absent means the whole corpus, and a non-empty list is a hard restriction that nothing in the backend widens. A second query resolves `speaker_codes` to display names per meeting. Score is reported as `1 - distance`. |
| **Self-scoped** | When the plan says the question is about the asker, the dense layer is skipped entirely. Chunks carry no participant filter, so an unfiltered excerpt of somebody else's request is exactly the wrong evidence for "내가 요청한 게 뭐야?". |
| **Failure** | No rows from either layer → `answer()` returns the "not found" message with an empty source list and makes no LLM call. A "내가" question from an account with no speaker mapping returns `rag.NO_IDENTITY` and no sources — it is never answered with a guess. |

Dense vectors only, in both layers. No lexical, keyword, or hybrid search. The
structured layer narrows *which* facts are candidates with SQL; it does not rank
them any differently.

## 9. Answer generation

| | |
|---|---|
| **Responsibility** | Compose an answer *from the retrieved evidence only*. It is not a retrieval step and not a source of facts. |
| **Input** | Numbered evidence blocks from `build_context`, the question **exactly as typed**, and up to `rag.HISTORY_MESSAGES` prior turns of the same chat. A chunk block is meeting title, time range, speakers, and the text. A fact block additionally carries its type, participants by role, deadline, status in words (`미확인` when the meeting never said), meeting date, and the transcript text it came from — a structured claim is never shown without its 원문. |
| **Output** | `{answer, sources[]}`; sources shaped by `serialize_sources`. |
| **Implementation** | `app/services/rag.py:answer`. OpenAI Chat Completions, `OPENAI_MODEL` (default `gpt-4o-mini`), `temperature=0`. The system prompt forbids inventing anything outside the evidence, requires `rag.NO_ANSWER` ("회의록에서 해당 내용을 찾지 못했습니다.") when the evidence does not answer, asks for `[1]`-style citations, and forbids calling a `미확인` status either finished or outstanding. Prior turns sit between the system prompt and the evidence, so a follow-up such as "그 부서는?" resolves — they inform the wording of the answer, never its facts. |
| **Failure** | No API key → evidence returned with an explanatory answer, no call made. Call raises → caught and logged, evidence still returned. Retrieval success and generation success are reported independently. |

Provenance fields are a contract; see "RAG / provenance invariant" in
[AGENTS.md](../../AGENTS.md).


## 10. Whole-transcript assists

Not part of `pipeline.process` and not part of indexing. Both read a meeting's
stored transcript in one pass and hand it to OpenAI; neither writes to
`transcript_segments`, `speakers`, or `meetings.status`.

### Summary

| | |
|---|---|
| **Responsibility** | Condense an approved meeting into 핵심 요약 / 주요 논의 / 결정 사항 / Action Items. |
| **Input** | `pipeline.load_transcript`, rendered as `화자 A: …` lines by `chunking._render` — the same rendering the evidence text uses. `COMPLETED` only; anything else is a `409` before the model is called. |
| **Output** | One row in `meeting_summaries`, keyed by `meeting_id`, upserted so a regeneration replaces rather than accumulates. |
| **Implementation** | `app/services/assist.py:summarize`. The prompt forbids inventing content and forbids an owner or a due date that the meeting did not state. |
| **Failure** | No API key → `400`. Call raises → `502`; no row is written and any previous summary stands. |

Re-embedding does not change the transcript, so it does not invalidate a summary.
Deleting the meeting removes it by cascade.

### STT correction suggestions

| | |
|---|---|
| **Responsibility** | Propose fixes for obvious misrecognitions, using the whole meeting as context. |
| **Input** | Every segment as `<sequence>: <text>`. `REVIEW_REQUIRED` only. |
| **Output** | `[{sequence, before, after}]` for changed segments only. Nothing is persisted. |
| **Implementation** | `app/services/assist.py:suggest_corrections`, JSON response format. The prompt forbids meaning changes, new facts, guessed numbers/amounts/dates, guessed names, and any timestamp or speaker change. `before` is read from the database, and a suggestion whose sequence is unknown or whose text is unchanged is dropped — a hallucinated line cannot reach the reviewer's editor. |
| **Failure** | Unparseable JSON → logged, empty list. No API key → `400`. Call raises → `502`. |

The reviewer applies suggestions in the browser and saves them with the existing
`PATCH /api/meetings/{id}/transcript`. **Nothing here approves anything**, and
the human approval invariant is unchanged.
