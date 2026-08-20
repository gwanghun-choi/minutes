# Minutes

회의 음성을 업로드하면 STT · 화자 분리 · 회의록 생성 · 임베딩 색인까지 자동으로 처리하고,
저장된 회의록을 대상으로 근거를 제시하는 RAG 챗봇을 제공하는 웹 애플리케이션.

이 저장소에서 작업하는 경우 [AGENTS.md](AGENTS.md)(불변 규칙)와
[CLAUDE.md](CLAUDE.md)(작업 흐름)를 먼저 읽는다.
상세 구조·파이프라인·작업 기록은 [docs/](docs/README.md)에 있다.

---

## 1. 과제 요구사항 대응

| 요구사항 | 구현 |
|---|---|
| 오픈소스 STT | faster-whisper (`medium`, CTranslate2) |
| 오픈소스 화자 분리 | pyannote.audio `speaker-diarization-community-1` |
| 화자별 / 시간대별 회의록 | STT segment ↔ diarization turn 시간 overlap 병합 |
| PostgreSQL 저장 | 기존 `didim_api` DB의 신규 `minutes` schema |
| 발화 단위 chunking | utterance-aware chunking (고정 문자 분할 아님) |
| 로컬 embedding | BAAI/bge-m3 (1024-dim, sentence-transformers) |
| pgvector 저장 | `minutes.chunks.embedding vector(1024)` + HNSW cosine index |
| RAG 검색 | 전체 회의 / 특정 회의 범위 dense Top-K |
| LLM 답변 | OpenAI Chat Completions (최종 답변 생성 전용) |
| 근거 표시 | 회의명 · 화자 · timestamp · 원문 chunk |
| Web UI | FastAPI + Jinja2 + Vanilla JS (3 화면) |
| Docker 배포 | 단일 애플리케이션 이미지 + compose |

---

## 2. Architecture

```
        브라우저 (Jinja2 + Vanilla JS)
                  │
                  ▼
        FastAPI (app/main.py)
        ├── /api/meetings   업로드 · 목록 · 상세 · 상태 · 화자명 수정
        └── /api/chat       질의응답
                  │
                  ▼
        BackgroundTasks  (app/services/pipeline.py)
                  │
   ┌──────────────┼──────────────┬───────────────┬──────────────┐
   ▼              ▼              ▼               ▼              ▼
 FFmpeg      faster-whisper   pyannote      chunking        BGE-M3
16k mono wav     STT         diarization   utterance 단위   embedding
   └──────────────┴──────────────┴───────────────┴──────────────┘
                  │
                  ▼
        PostgreSQL 16 + pgvector 0.8.2  (schema: minutes)
                  │
                  ▼
        RAG 검색 (cosine Top-K)  ──►  OpenAI  ──►  answer + sources
```

DB는 새로 띄우지 않는다. 기존 `didim_api` 인스턴스에 `minutes` schema만 추가한다.

---

## 3. 사용 기술

| 영역 | 선택 |
|---|---|
| Backend | Python 3.11, FastAPI, uvicorn |
| Frontend | Jinja2, HTML/CSS, Vanilla JS (빌드 시스템 없음) |
| Audio | FFmpeg (`imageio-ffmpeg` 정적 바이너리 fallback 포함) |
| STT | faster-whisper 1.1.1 |
| Diarization | pyannote.audio 4.0 |
| Embedding | sentence-transformers, BAAI/bge-m3 |
| Vector store | PostgreSQL 16 + pgvector 0.8.2 |
| DB driver | psycopg 3 (ORM 없음, 원시 SQL) |
| LLM | OpenAI Chat Completions |

RAG는 LangChain / LlamaIndex 없이 직접 구현했다. 검색·프롬프트·근거 직렬화가
각각 함수 하나 수준이라 프레임워크를 넣을 이유가 없었다.

---

## 4. 음성 분석 흐름

1. **정규화** — 업로드 파일을 FFmpeg로 16 kHz mono WAV로 변환한다.
   faster-whisper와 pyannote가 모두 이 포맷을 기대하므로 한 번만 변환한다.
   지원 입력: `wav` `mp3` `m4a` `flac` `ogg` `webm` `mp4`
2. **STT** — faster-whisper, VAD 필터 사용, 언어 자동 감지(`WHISPER_LANGUAGE`로 고정 가능).
   결과: `[{start, end, text}]`
3. **화자 분리** — pyannote `speaker-diarization-community-1`.
   결과: `[{start, end, speaker}]` (`SPEAKER_00`, `SPEAKER_01`, …)
4. **병합** — 각 STT segment에 대해 diarization turn과의 시간 overlap을 계산하고,
   overlap 합이 가장 큰 화자를 할당한다 (`app/services/transcript.py`).
5. **저장** — `speakers`에 `SPEAKER_00 → 화자 A` 매핑을 만들고 `transcript_segments`에 발화를 저장한다.
   UI에서 화자 표시명을 직접 수정할 수 있다.

### 화자 분리에 대한 설명

diarization은 "누가 언제 말했는가"만 판별한다. 실제 사람 이름은 인식하지 않으며
구현하지도 않았다. 따라서 화자는 `SPEAKER_00` 같은 익명 코드로 나오고, UI에서는
`화자 A`, `화자 B`로 표시한다. 필요하면 사용자가 실명으로 바꿀 수 있다.

MVP에서는 한 STT segment에 화자 하나만 할당한다. 한 segment가 화자 전환 지점을
가로지르면 그 segment 전체가 더 많이 겹친 화자에게 귀속된다. 이를 더 잘게 나누려면
word-level timestamp가 필요하다.

---

## 5. Chunking 정책

고정 500자 분할은 쓰지 않는다. 회의록에는 이미 **발화**라는 자연스러운 경계가 있고,
질문과 답변이 서로 다른 chunk로 잘리면 검색 품질이 크게 떨어지기 때문이다.

`app/services/chunking.py`:

- chunk = 연속된 발화들의 묶음. 발화 중간에서 절대 자르지 않는다.
- 목표 약 320 token, 상한 약 420 token (한국어는 1.5자 ≈ 1 token으로 근사)
- 한 chunk당 최대 7 발화
- 다음 chunk는 이전 chunk의 마지막 2 발화를 overlap으로 가져간다
- chunk 본문은 `화자 A: …` 형태로 화자 표시명을 포함하고,
  `start_time` · `end_time` · `speaker_codes`를 metadata로 유지한다

```
화자 A: 개발 서버 일정은 어떻게 됐어요?
화자 B: 금요일까지 준비합니다.
화자 A: GPU 서버도 포함인가요?
화자 B: 네, 같이 준비합니다.
```
이 덩어리 하나가 하나의 embedding 단위가 된다.

형태소 분석기(Nori, MeCab 등)는 쓰지 않는다. BGE-M3는 자체 subword tokenizer를 쓰는
dense 모델이라 형태소 분해를 앞단에 넣으면 오히려 입력 분포가 망가진다.

---

## 6. RAG 구조

```
질문 → BGE-M3 임베딩 → pgvector cosine Top-K (회의 필터 선택적)
     → 번호가 붙은 근거 블록으로 context 구성 → OpenAI → 답변 + 근거
```

- 검색 범위: `meeting_id = null`이면 전체 회의, 값이 있으면 해당 회의만.
- 거리 연산자는 `<=>` (cosine). 임베딩은 정규화해서 저장한다.
- 프롬프트는 근거 블록만 사용하도록 제한하고, 근거로 답할 수 없으면
  "회의록에서 해당 내용을 찾지 못했습니다."만 답하도록 지시한다.
- 응답의 `sources[]`에는 회의 ID·회의명·화자·시작/종료 timestamp·원문 chunk·유사도가 들어간다.
- LLM 호출이 실패해도 검색 결과(근거)는 그대로 반환한다.

---

## 7. DB Schema (`minutes`)

| 테이블 | 내용 |
|---|---|
| `meetings` | id, title, original_filename, stored_filename, duration, language, status, error_message, created_at |
| `speakers` | id, meeting_id, speaker_code, display_name — `(meeting_id, speaker_code)` unique |
| `transcript_segments` | id, meeting_id, speaker_id, sequence, start_time, end_time, text |
| `chunks` | id, meeting_id, sequence, content, start_time, end_time, speaker_codes[], embedding `vector(1024)` |

- DDL은 `scripts/init_db.sql`. 전부 `IF NOT EXISTS`이므로 재실행해도 안전하다.
- 애플리케이션 시작 시 자동 적용되며, `minutes` schema 밖은 건드리지 않는다.
  (예외: `CREATE EXTENSION IF NOT EXISTS vector` — DB 전역이지만 추가만 한다.)
- vector 차원은 **임베딩 모델에서 읽어온 값**을 그대로 쓴다. 기존 테이블 차원이
  모델 차원과 다르면 기동 시 에러로 알린다.
- 인증/사용자/audit 테이블은 없다.

---

## 8. 실행

### 로컬

```bash
uv venv --python 3.11 .venv
uv pip install -r requirements.txt
cp .env.example .env      # 값 채우기
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 18080
```

첫 실행 시 faster-whisper와 BGE-M3 모델을 내려받는다(수 GB, 수 분).

- 회의 목록 / 업로드 : `http://localhost:18080/`
- 회의 상세 : `http://localhost:18080/meetings/{id}`
- 챗봇 : `http://localhost:18080/chat`

### Docker

```bash
docker compose up -d --build
```

- 애플리케이션 컨테이너 하나만 뜬다. PostgreSQL은 기존 외부 인스턴스를 쓴다.
- `18080 → 8000`으로 노출한다.
- named volume `models`(모델 캐시)와 `uploads`(업로드 음성)를 붙여서
  컨테이너를 다시 만들어도 재다운로드/유실이 없다.
- GPU 호스트에서는 `compose.yaml`의 `deploy.resources` 블록 주석을 해제한다
  (NVIDIA Container Runtime 필요).
- 컨테이너는 호스트의 `/etc/ssl/certs/ca-certificates.crt`를 읽기 전용으로 마운트한다.
  TLS를 가로채는 사내 프록시 환경에서 모델 다운로드가
  `CERTIFICATE_VERIFY_FAILED`로 실패하는 것을 막기 위한 것이고, 그 외 환경에서는 무해하다.

### 테스트

`pytest`는 개발 전용이라 `requirements.txt`에 넣지 않았다(이미지에 포함되지 않게 하기 위함).

```bash
uv pip install pytest
.venv/bin/python -m pytest tests -q
```

모델을 내려받거나 음성을 처리하지 않는 순수 로직 테스트 6개만 있다.
실제 품질 검증은 Human UAT로 한다.

---

## 9. 환경변수

`.env.example` 참고. 실제 값은 `.env`에만 두며 저장소에 커밋하지 않는다.

| 변수 | 설명 |
|---|---|
| `DATABASE_HOST` / `PORT` / `NAME` / `USER` / `PASSWORD` | 기존 PostgreSQL 접속 정보 |
| `DATABASE_SCHEMA` | 기본 `minutes` |
| `HF_TOKEN` | pyannote 모델 다운로드용. 해당 HF 계정이 모델 라이선스에 동의되어 있어야 한다 |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 최종 답변 생성용 |
| `WHISPER_MODEL` | `tiny` … `large-v3` (기본 `medium`) |
| `WHISPER_DEVICE` | `auto` / `cuda` / `cpu` |
| `WHISPER_COMPUTE_TYPE` | `auto` / `int8` / `float16` / `int8_float16` |
| `WHISPER_LANGUAGE` | 비우면 자동 감지 |
| `EMBEDDING_MODEL` | 기본 `BAAI/bge-m3` |
| `EMBEDDING_DEVICE` | `auto` / `cuda` / `cpu` |
| `UPLOAD_DIR` | 업로드 저장 경로 |

`auto` device는 사용 가능한 CUDA 런타임이 실제로 있을 때만 GPU를 쓰고, 아니면 CPU로 내려간다.

---

## 10. API

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/meetings` | multipart `file`, `title`. 즉시 응답하고 백그라운드로 분석 |
| `GET` | `/api/meetings` | 목록 (화자 수 포함) |
| `GET` | `/api/meetings/{id}` | 회의 + 화자 + 전체 발화 |
| `GET` | `/api/meetings/{id}/status` | 분석 상태 (UI가 2초 폴링) |
| `PATCH` | `/api/meetings/{id}/speakers/{speaker_id}` | 화자 표시명 변경 |
| `POST` | `/api/chat` | `{"question": "...", "meeting_id": null}` → `{answer, sources[]}` |
| `GET` | `/health` | 헬스체크 |

분석 상태: `UPLOADED` → `TRANSCRIBING` → `DIARIZING` → `INDEXING` → `COMPLETED` / `FAILED`

---

## 11. 오픈소스 모델

| 용도 | 모델 | 라이선스 |
|---|---|---|
| STT | `Systran/faster-whisper-medium` (OpenAI Whisper 변환본) | MIT |
| 화자 분리 | `pyannote/speaker-diarization-community-1` | gated, 사용 조건 동의 필요 |
| 임베딩 | `BAAI/bge-m3` (1024-dim, 다국어/한국어) | MIT |

BGE-M3를 그대로 채택했다. 로컬 CPU에서 chunk 임베딩이 chunk당 수십 ms 수준이라
더 작은 모델로 낮출 이유가 없었다.

---

## 12. 데모 URL

```
http://<NCP_SERVER_IP>:18080/
```

---

## 13. 현재 한계

- **백그라운드 처리에 내구성이 없다.** FastAPI `BackgroundTasks`로 처리하므로
  분석 도중 서버가 재기동되면 그 작업은 유실되고 상태가 중간 단계에 멈춘다.
  재업로드가 필요하다.
- **동시 처리 제어가 없다.** 여러 회의를 동시에 올리면 STT가 같은 프로세스에서
  경쟁한다. 큰 파일 여러 개를 동시에 올리면 느려진다.
- **화자 분리는 end-to-end로 검증되지 않았다.** pyannote 모델이 gated이고 사용 가능한
  `HF_TOKEN` 계정이 라이선스에 동의하지 않아, 지금까지 관측된 모든 실행은
  단일 화자 fallback 경로를 탔다. 코드 경로는 구현되어 있으나 실제 다화자 출력은
  확인된 적이 없다.
- **chat 최종 답변도 end-to-end로 검증되지 않았다.** 사용 가능한 `OPENAI_API_KEY`가
  `invalid_organization` 401을 반환한다. 검색·근거 반환까지만 검증됐다.
- **화자 전환 정밀도.** 한 STT segment에 화자 하나만 할당한다(위 4절 참고).
- **검색은 dense 벡터 Top-K 단독.** 고유명사·숫자·코드 같은 정확 일치 검색은 약하다.
- **화자 표시명은 수동이고, 재분석 시 사라진다.** 실제 이름 자동 인식은 없다.
  파이프라인을 다시 실행하면 `speakers` 행을 지우고 다시 만들기 때문에
  사용자가 수정한 표시명이 초기화된다.
- **`error_message`가 경고에도 쓰인다.** 화자 분리에 실패해도 회의는 `COMPLETED`로
  끝나고, 그 경고 문구가 `error_message`에 담겨 UI에 오류 스타일로 표시된다.
- **인증 없음.** 접근 제어가 전혀 없으므로 공개 인터넷에 그대로 노출하면 안 된다.
- **개발 환경은 CPU 추론.** 로컬 GPU(GTX 1050 Ti)는 가용 VRAM이 부족하고
  설치된 드라이버(CUDA 12.6)가 배포된 torch 빌드보다 낮아 CPU/int8로 동작시켰다.
  `WHISPER_DEVICE=cuda`로 GPU 호스트에서는 그대로 GPU를 쓴다.

---

## 14. 향후 확장

- **API / GPU Worker 분리** — 업로드 API와 추론 워커를 분리하고 그 사이에 큐를 둔다.
  현재 `pipeline.process()`가 그대로 워커 진입점이 된다.
- **durable queue** — 재기동에도 살아남는 작업 큐로 위 "한계" 1·2번을 해소한다.
- **S3 / Object Storage** — 업로드 음성을 로컬 볼륨이 아닌 오브젝트 스토리지로 옮겨
  워커를 무상태로 만든다.
- **OpenSearch + Nori + BM25 / Vector Hybrid** — 데이터가 늘어나고,
  정확 키워드 검색 요구가 커지고, 한국어 lexical search가 필요해지면
  Nori 형태소 분석 기반 BM25와 현재 dense 검색을 RRF로 결합한다.
  (형태소 분석은 **lexical 색인에만** 쓰고 dense embedding 입력에는 넣지 않는다.)
- **Reranking** — cross-encoder 재순위화로 Top-K 정밀도를 올린다.
- **Streaming transcription** — 회의 종료 후 일괄 처리 대신 실시간 자막.
