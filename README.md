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
| RAG 검색 | 전체 회의 / 선택한 복수 회의 범위 dense Top-K |
| LLM 답변 | OpenAI Chat Completions (최종 답변 생성 전용) |
| 근거 표시 | 회의명 · 화자 · timestamp · 원문 chunk |
| Web UI | FastAPI + Jinja2 + Vanilla JS (4 화면) |
| **HITL 검토 게이트** | 승인 전까지 chunk/embedding 자체를 만들지 않음 |
| POC 로그인 | username/password + 서버 세션. 사용자별 대화 이력 분리 전용 |
| 대화형 챗봇 | 대화 저장·재열람·삭제, 직전 대화 맥락 유지 |
| 검색 범위 지정 | 회의명 검색·기간 필터 모달, 복수 회의 선택, 대화별 저장 |
| 회의 요약 | 승인된 회의 대상 핵심 요약 / 주요 논의 / 결정 사항 / Action Items |
| AI 후보정 | 검토 단계에서 STT 오인식 후보 제안 (자동 저장·자동 승인 없음) |
| Docker 배포 | 단일 애플리케이션 이미지 + compose |
| DB 스키마 관리 | `scripts/migrations/*.sql` + 명시적 migration 명령 (기동 시 DDL 없음) |

---

## 2. Architecture

```
        브라우저 (Jinja2 + Vanilla JS)
                  │
                  ▼
        (배포 단계) python -m scripts.migrate → schema_migrations
                  │  기동은 스키마를 만들지 않고 적용 여부만 읽기 전용으로 확인한다
                  ▼
        FastAPI (app/main.py)
        ├── require_login   /health · /login · 로그인 API · /static 외 전부 차단
        ├── /api/auth       로그인 · 로그아웃 · 현재 사용자
        ├── /api/meetings   업로드 · 목록 · 상세 · 상태 · 회의록 수정 · 승인
        │                   · 재임베딩 · 삭제 · 요약 · AI 후보정
        └── /api/chat       대화 목록/생성/삭제 · 검색 범위 · 질의응답
                  │
                  ▼
        BackgroundTasks  (app/services/pipeline.py)
                  │
   ┌──────────────┼──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
 FFmpeg      faster-whisper   pyannote     overlap 병합
16k mono wav     STT         diarization   → 초안 회의록 저장
   └──────────────┴──────────────┴──────────────┘
                  │
                  ▼
        ══ HITL 검토 게이트 (REVIEW_REQUIRED) ══
        사람이 수정하고 승인할 때까지 여기서 멈춘다.
        이 시점에는 chunk도 embedding도 존재하지 않는다.
                  │  POST /api/meetings/{id}/approve
                  ▼
        chunking (utterance 단위) → BGE-M3 embedding
                  │   ▲
                  │   └── POST /api/meetings/{id}/reindex (재임베딩)
                  │       승인된 회의록으로 이 구간만 다시 실행
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
   여기서 분석이 끝나고 회의는 `REVIEW_REQUIRED`가 된다.
6. **검토 및 승인** — 아래 §4-1.

### 4-1. HITL 검토 게이트

**AI가 만든 회의록은 초안이다. 사람이 검토하고 승인해야만 RAG 지식이 된다.**

STT는 숫자와 고유명사를 자주 틀리고, diarization은 화자를 잘못 붙인다. 승인 게이트가
없으면 그 결과가 그대로 답변의 근거가 된다. 그래서 파이프라인을 둘로 나눴다.

- 분석은 회의록 저장까지만 하고 `REVIEW_REQUIRED`에서 멈춘다.
  **이 시점에는 chunk도 embedding도 만들어지지 않으므로 검색 대상 자체가 없다.**
- 회의 상세 화면이 곧 검토 화면이다. 발화 텍스트 수정, 발화의 화자 재지정,
  화자 표시명 변경이 가능하다.
- 승인 이후에는 회의록이 **불변**이다. 발화 텍스트·화자 지정뿐 아니라 화자 표시명 수정도
  서버에서 거부된다(`409`). UI 비활성화에만 의존하지 않는다.
- `승인 및 RAG 인덱싱`을 누르면 그때 chunking → embedding → 저장이 실행된다.
- 인덱싱은 **DB에 저장된 현재 회의록**을 다시 읽어서 수행한다. 따라서 사람이 고친
  내용이 근거가 되고, AI 초안은 남지 않는다.
- 승인은 `status = 'REVIEW_REQUIRED'` 조건부 UPDATE 한 번으로 처리한다. 두 번 눌러도
  두 번째는 `409`가 되어 chunk가 중복되지 않는다.
- 인덱싱이 실패하면 회의록은 그대로 두고 다시 `REVIEW_REQUIRED`로 되돌린다. 수정 후
  다시 승인하면 된다.

**재임베딩.** 승인이 끝난 회의는 상세 화면의 `재임베딩` 버튼으로 검색 인덱스만 다시
만들 수 있다. chunking 상수나 임베딩 모델을 바꿨을 때 기존 회의를 재업로드 없이 현재
인덱스에 맞추기 위한 것이다.

- 실행되는 것은 **chunking → embedding → chunk 재생성**뿐이다. FFmpeg·STT·화자 분리는
  다시 돌지 않고, 회의록과 화자도 다시 만들지 않는다. 원본 음성을 다시 분석하는
  기능이 아니다.
- `COMPLETED`인 회의에서만 가능하다. 그 외 상태에서는 `409`다.
- 승인과 동일한 조건부 UPDATE로 상태를 선점하므로, 두 번 눌러도 한 번만 실행된다.
- 실패해도 **기존 인덱스는 그대로 남고** 상태는 `COMPLETED`로 되돌아간다. 임베딩은
  트랜잭션 밖에서 먼저 계산하고, 기존 chunk 삭제와 새 chunk 삽입은 한 트랜잭션 안에서
  일어나기 때문에 절반만 교체된 인덱스가 커밋될 수 없다.

**회의 삭제.** 상세 화면의 `회의 삭제` 버튼으로 회의 하나와 거기 딸린 모든 데이터를
지운다. `meetings` 한 행을 지우면 `speakers` · `transcript_segments` · `chunks`가
`ON DELETE CASCADE`로 함께 사라지고, 업로드 원본과 정규화된 `.16k.wav`도 삭제된다.

- **정착 상태에서만 가능하다** — `REVIEW_REQUIRED` · `COMPLETED` · `FAILED`. 백그라운드
  작업이 파일과 DB를 쓰고 있는 `TRANSCRIBING` · `DIARIZING` · `INDEXING`, 그리고 분석이
  곧 시작되는 `UPLOADED`에서는 `409`다. 취소 기능은 만들지 않았다.
- DB를 먼저 지우고 파일을 지운다. 파일 삭제가 실패하면 참조 없는 파일이 남을 뿐이지만,
  순서가 반대면 음성이 없는 회의 행이 남는다.
- 삭제 대상 경로는 `stored_filename`에서만 만들고 `UPLOAD_DIR` 안으로 강제한다.
  모델 캐시나 다른 회의의 파일에는 닿지 않는다.

설계 근거와 기각한 대안: [docs/decisions/2026-08-20-hitl-transcript-review-gate.md](docs/decisions/2026-08-20-hitl-transcript-review-gate.md)

### 4-2. AI 후보정 (STT 오인식 교정)

`REVIEW_REQUIRED`에서만 쓸 수 있다. `[AI 후보정]`을 누르면 **회의록 전체**를 문맥으로
넘겨 오인식으로 보이는 문장만 골라 `변경 전 / 변경 후`로 제안한다.

```
POST /api/meetings/{id}/corrections
→ {"suggestions": [{"sequence": 0, "before": "병환경로업의 결제금액 작성",
                    "after": "병원 경로별 결제금액 작성"}]}
```

- 제안은 **DB를 바꾸지 않는다.** `[후보정 반영]`은 브라우저의 편집 중인 회의록 값만
  바꾸고, 실제 저장은 기존 `[수정 내용 저장]`(PATCH)이 한다.
- 승인은 여전히 사람이 별도로 누른다. 후보정이 승인을 대신하지 않는다.
- `before`는 모델이 아니라 DB에서 읽는다. 존재하지 않는 문장 번호나 내용이 같은 제안은
  버려지므로, 없는 문장이 편집기에 들어올 수 없다.
- 프롬프트에서 의미 변경·사실 추가·숫자/금액/날짜 추정·인명/회사명 추측·timestamp/화자
  변경을 금지한다.

### 4-3. 회의 요약

승인된(`COMPLETED`) 회의만 요약할 수 있다. 초안 상태에서는 `409`로 거부한다.
사람이 검토하지 않은 문장에 검토된 요약과 같은 무게를 실을 수 없기 때문이다.

- 항목은 `핵심 요약` · `주요 논의` · `결정 사항` · `Action Items` 넷이다.
- 회의에서 언급되지 않은 담당자·기한을 만들어내지 않도록 프롬프트에 명시한다.
- 결과는 `meeting_summaries`에 회의당 한 행으로 저장한다. 다시 생성하면 그 행을
  덮어쓴다(같은 회의록으로 매번 OpenAI를 호출하지 않는다).
- 재임베딩은 회의록을 바꾸지 않으므로 요약을 무효화하지 않는다.
- 회의를 삭제하면 FK cascade로 요약도 함께 사라진다.

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

- **승인된(`COMPLETED`) 회의만 검색한다.** 승인 전 회의는 애초에 chunk가 없고,
  질의 조건에도 status 필터가 걸려 있다.
- 검색 범위: `chat_sessions.scope_meeting_ids`가 비어 있으면 전체 회의,
  값이 있으면 **그 회의들만** (`c.meeting_id = ANY(...)`).
- 거리 연산자는 `<=>` (cosine). 임베딩은 정규화해서 저장한다.
- 프롬프트는 근거 블록만 사용하도록 제한하고, 근거로 답할 수 없으면
  "회의록에서 해당 내용을 찾지 못했습니다."만 답하도록 지시한다.
- 응답의 `sources[]`에는 회의 ID·회의명·화자·시작/종료 timestamp·원문 chunk·유사도가 들어간다.
- LLM 호출이 실패해도 검색 결과(근거)는 그대로 반환한다.

### 6-1. 대화 맥락

직전 대화 `rag.HISTORY_MESSAGES`(10)개를 system 프롬프트와 근거 사이에 그대로 넣는다.
요약이나 memory framework는 쓰지 않는다.

```
User      어음으로 분류된 건 어느 부서 협조가 필요해?
Assistant 재무지원실입니다. [1]
User      그 부서는 어떤 기준으로 기록한다고 했지?   ← "그 부서" = 재무지원실
```

검색 질의는 **입력한 문장 그대로** 임베딩한다. 대화 맥락은 답변 생성에만 전달되고
검색어 재작성은 하지 않는다(§13 참고).

### 6-2. 검색 범위와 명시적 전체 검색

범위를 지정한 대화에서는 **백엔드가 절대 스스로 범위를 넓히지 않는다.**
사용자가 제외한 회의에서 답을 만들어 오면, 그 답이 무엇에 대한 근거인지가 조용히
달라지기 때문이다.

```
범위: 결제 프로세스 회의
질문: GPU 서버 일정은 언제야?

→ 선택한 회의에서는 해당 내용을 찾지 못했습니다.
  전체 회의에서 다시 찾아볼까요?   [전체 회의에서 검색]
```

- 응답의 `scope_miss`는 **질문일 뿐 재검색이 아니다.**
- `[전체 회의에서 검색]`은 같은 질문을 `global_override: true`로 한 번 더 보낸다.
  그 질문에만 적용되고, 대화의 기본 범위는 그대로 유지된다.
- miss 판정은 별도 threshold가 아니라 근거 프롬프트가 이미 쓰는
  `"회의록에서 해당 내용을 찾지 못했습니다."` 문장을 그대로 재사용한다.

---

## 7. DB Schema (`minutes`)

| 테이블 | 내용 |
|---|---|
| `meetings` | id, title, original_filename, stored_filename, duration, language, status, error_message, created_at |
| `speakers` | id, meeting_id, speaker_code, display_name — `(meeting_id, speaker_code)` unique |
| `transcript_segments` | id, meeting_id, speaker_id, sequence, start_time, end_time, text |
| `chunks` | id, meeting_id, sequence, content, start_time, end_time, speaker_codes[], embedding `vector(1024)` |
| `meeting_summaries` | meeting_id (PK·FK cascade), content, created_at — 회의당 1행 |
| `users` | id (내부 PK), username (로그인 ID, unique), password_hash (scrypt), display_name, is_active, created_at, updated_at, last_login_at |
| `schema_migrations` | version (PK), name, applied_at — 적용된 migration 기록 |
| `auth_sessions` | id (쿠키에 담기는 불투명 토큰), user_id, created_at |
| `chat_sessions` | id, user_id, title, `scope_meeting_ids BIGINT[]` (비어 있으면 전체), created_at, updated_at |
| `chat_messages` | id, session_id, role, content, `sources JSONB`, created_at |

- DDL은 `scripts/migrations/*.sql`이고 **배포 단계에서 명시적으로만** 적용된다
  (`python -m scripts.migrate`). 애플리케이션 기동은 스키마를 만들지도 바꾸지도 않는다.
- 적용 이력은 `schema_migrations`에 남고, migration 하나는 자기 기록과 같은 트랜잭션에서
  적용된다. 실패하면 롤백되고 version이 기록되지 않으므로 다음 실행에서 다시 시도한다.
- 각 파일은 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 기반이라 기존 테이블이 이미 있는
  DB에서도 안전하다. DROP이나 초기화는 어디에도 없다.
- `minutes` schema 밖은 건드리지 않는다.
  (예외: `CREATE EXTENSION IF NOT EXISTS vector` — DB 전역이지만 추가만 한다.)
- vector 차원은 migration 001이 `vector(1024)`로 고정한다(BAAI/bge-m3). 기동 시
  `migrate.verify()`가 모델 차원과 다르면 **읽기 전용으로 확인만 하고** 에러로 알린다.
- `scope_meeting_ids`는 join table이 아니라 배열이고 FK가 없다. 전체/선택 두 상태는
  "id가 적혀 있는가"만 다르고, 삭제된 회의 id가 남아도 검색 결과가 없을 뿐이다.
- audit 테이블은 없다. 권한/역할 테이블도 없다(회의는 모든 로그인 사용자가 본다).

---

## 8. 실행

### 로컬

```bash
uv venv --python 3.11 .venv
uv pip install -r requirements.txt
cp .env.example .env               # 값 채우기
.venv/bin/python -m scripts.migrate   # DB 스키마 적용 (기동 전에 한 번)
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 18080
```

migration을 먼저 실행하지 않으면 애플리케이션이
`DB migration이 필요합니다.`로 기동을 거부한다. 이미 적용된 DB에서 다시 실행하면
`applied 0 migration(s): none`으로 끝난다.

첫 실행 시 faster-whisper와 BGE-M3 모델을 내려받는다(수 GB, 수 분).

- 로그인 : `http://localhost:18080/login`
- 회의 목록 / 업로드 : `http://localhost:18080/`
- 회의 상세 겸 검토·승인 : `http://localhost:18080/meetings/{id}`
- 챗봇 : `http://localhost:18080/chat`

#### 기본 POC 계정

```
ID: user
PW: user1234
```

migration `003_user_identity`가 만드는 계정이다. DB에는 scrypt 해시만 저장되며
평문 비밀번호는 어디에도 남지 않는다. 이미 `user`가 있으면 migration을 다시 돌려도
비밀번호를 **덮어쓰지 않는다.**

> ⚠️ 공개적으로 알려진 POC 기본 credential이다. 운영/외부 공개 전에 반드시 변경해야 한다.
> 계정 관리 UI는 아직 없으므로 지금은 DB에서 직접 바꾼다
> (`UPDATE minutes.users SET password_hash = ... WHERE username = 'user'`,
> 해시는 `app.services.auth.hash_password`로 생성).

### Docker

```bash
docker compose build
docker compose run --rm minutes python -m scripts.migrate   # 먼저 스키마
docker compose up -d                                        # 그다음 기동
```

- migration은 애플리케이션 기동과 분리된 별도 명령이다. 새 컨테이너를 먼저 띄우고
  나중에 migration하는 순서가 되면 안 된다.
- migration 명령은 같은 이미지를 쓰지만 모델을 로드하지 않으므로 수 초 안에 끝난다.
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

- `tests/test_core.py` — 순수 로직 6개. 모델도 DB도 쓰지 않는다.
- `tests/test_migrate.py` — migration runner 10개.
- `tests/test_hitl.py` — 승인 게이트·재임베딩·삭제 23개.
- `tests/test_auth.py` — 인증 경계 15개.
- `tests/test_chat.py` — 대화 소유권·multi-turn·검색 범위 15개.
- `tests/test_assist.py` — 요약·AI 후보정 12개.

migration 테스트만은 `minutes`가 아니라 `minutes_test_<random>` 임시 schema를 만들어
쓰고 끝나면 지운다. 실제 회의 데이터가 있는 schema에는 fresh-DB migration을 시험할 수 없기
때문이다. 나머지 DB 테스트는 실제 `minutes` schema에 접속하고, 임베딩과 OpenAI만 가짜로
대체한다. 자기 회의·자기 계정만 만들고 끝나면 지운다. DB에 접속할 수 없으면 skip된다.

실제 음성 품질 검증은 Human UAT로 한다.

---

## 9. 환경변수

`.env.example` 참고. 실제 값은 `.env`에만 두며 저장소에 커밋하지 않는다.

| 변수 | 설명 |
|---|---|
| `DATABASE_HOST` / `PORT` / `NAME` / `USER` / `PASSWORD` | 기존 PostgreSQL 접속 정보 |
| `DATABASE_SCHEMA` | 기본 `minutes` |
| `HF_TOKEN` | pyannote 모델 다운로드용. 해당 HF 계정이 모델 라이선스에 동의되어 있어야 한다 |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 답변 생성·회의 요약·AI 후보정용 |
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
| `DELETE` | `/api/meetings/{id}` | **회의 삭제.** 회의록·화자·검색 인덱스·업로드 음성까지 함께 제거 |
| `GET` | `/api/meetings/{id}/status` | 분석 상태 (UI가 2초 폴링) |
| `PATCH` | `/api/meetings/{id}/transcript` | 검토 중 발화 텍스트·화자 일괄 수정 |
| `POST` | `/api/meetings/{id}/approve` | **승인.** 최초 RAG 인덱싱을 시작하는 유일한 경로 |
| `POST` | `/api/meetings/{id}/reindex` | **재임베딩.** 승인된 회의록으로 검색 인덱스만 다시 생성 |
| `PATCH` | `/api/meetings/{id}/speakers/{speaker_id}` | 화자 표시명 변경 |
| `GET`/`POST` | `/api/meetings/{id}/summary` | 저장된 요약 조회 / 생성·재생성 (`COMPLETED` 전용) |
| `POST` | `/api/meetings/{id}/corrections` | **AI 후보정 제안.** DB는 바꾸지 않는다 (`REVIEW_REQUIRED` 전용) |
| `POST` | `/api/auth/login` · `/api/auth/logout` | 로그인 / 로그아웃 |
| `GET` | `/api/auth/me` | 현재 사용자 |
| `GET`/`POST` | `/api/chat/sessions` | 내 대화 목록 / 새 대화 |
| `GET`/`PATCH`/`DELETE` | `/api/chat/sessions/{id}` | 대화 + 메시지 / 검색 범위 변경 / 삭제 |
| `POST` | `/api/chat/sessions/{id}/messages` | `{question, global_override, top_k}` → `{answer, sources[], scope_miss}` |
| `POST` | `/api/chat` | 단발성 질의. `{"question": "...", "meeting_id": null}` → `{answer, sources[]}` |
| `GET` | `/health` | 헬스체크 |

`/health`, `/login`, `POST /api/auth/login`, `/static/*`를 뺀 모든 경로는 세션이 필요하다.
세션이 없으면 API는 `401`, 페이지는 `/login`으로 `303`이다.

분석 상태:

```
UPLOADED → TRANSCRIBING → DIARIZING → REVIEW_REQUIRED → INDEXING → COMPLETED
                    │                        ▲                │          │
                    └──► FAILED              └────────────────┘          │
                                              인덱싱 실패 시 검토 단계로 복귀 │
                                  INDEXING ◄──────── 재임베딩 ─────────────┘
                                     └─ 실패 시 COMPLETED로 복귀 (기존 인덱스 유지)
```

`REVIEW_REQUIRED`가 사람의 승인 게이트다. `COMPLETED`는 **승인되어 인덱싱까지 끝난** 상태를 뜻한다.
재임베딩 중에는 잠시 `INDEXING`이 되므로 그동안 그 회의는 검색 대상에서 빠진다.

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
- **분석 도중 멈춘 회의는 삭제할 수 없다.** 재기동으로 `TRANSCRIBING` 등에 멈춘 행은
  삭제가 `409`로 거부된다. 취소 기능을 만들지 않았기 때문이다. 운영자가 해당 행을
  `FAILED`로 한 번 `UPDATE`하면 그 뒤로는 일반 삭제로 정리된다.
- **화자 분리와 최종 답변 생성은 NCP 환경에서만 검증됐다.** NCP 실환경 E2E에서
  183.72초 한국어 음성이 `SPEAKER_00` / `SPEAKER_01`로 실제 분리됐고, OpenAI 답변과
  provenance까지 확인됐다. 여기에는 모델 라이선스에 동의한 `HF_TOKEN`과
  `pyannote.audio>=4.0.3`이 필요하다(4.0.0은 `torch` 2.13에서 체크포인트를 열지 못한다).
  로컬 개발 환경의 `HF_TOKEN`·`OPENAI_API_KEY`는 각각 gated 403과 401을 받으므로,
  로컬 실행은 단일 화자 fallback과 근거만 반환하는 경로를 탄다.
- **화자 전환 정밀도.** 한 STT segment에 화자 하나만 할당한다(위 4절 참고).
- **검색은 dense 벡터 Top-K 단독.** 고유명사·숫자·코드 같은 정확 일치 검색은 약하다.
- **화자 표시명은 수동이다.** 실제 이름 자동 인식은 없다. (재분석 시 소실되던 문제는
  `speakers` upsert로 해결했다.)
- **`error_message`가 경고에도 쓰인다.** 화자 분리 실패 경고와 인덱싱 실패 오류가 같은
  컬럼을 쓰고, UI가 둘 다 오류 스타일로 표시한다. 문자열 하나 때문에 별도 알림 체계를
  만들 이유가 없어 그대로 뒀다.
- **승인된 회의는 다시 검토 상태로 되돌릴 수 없다.** `COMPLETED`를 `REVIEW_REQUIRED`로
  되돌리는 경로가 없어서, 인덱싱된 회의록을 나중에 고칠 수단이 없다.
- **게이트 도입 이전의 `COMPLETED` 회의는 승인을 거치지 않았다.** 2026-08-20 기준 DB의
  회의 3건 중 2건(`id 1`, `id 2`)이 여기 해당하며 모두 합성 데모 음성이다. 검색 조건이
  `COMPLETED`이므로 이들도 계속 검색된다. 스키마에 승인 사실을 기록하는 컬럼이 없어서
  데이터만으로는 승인된 회의와 구분되지 않는다. 즉 **불변식은 현재 코드가 인덱싱하는
  모든 것에 적용되지만 소급되지는 않는다.**
  (조치 방법: [decision record](docs/decisions/2026-08-20-hitl-transcript-review-gate.md#legacy-rows))
- **로그인은 신원 경계일 뿐 전송 보안이 아니다.** 현재 배포가 HTTP이므로 세션 쿠키에
  `secure`를 붙이지 않았고 네트워크에서 그대로 보인다. 신뢰할 수 없는 망에 노출하기
  전에 HTTPS 종단이 필요하다. (이번 범위 아님)
- **권한 체계는 없다.** 회의는 로그인한 모든 사용자가 본다. 격리되는 것은 대화 이력뿐이다.
- **계정 관리 기능이 없다.** 회원가입·비밀번호 변경·관리자 화면이 없다. 계정 추가나
  비활성화(`is_active = false`)는 지금은 DB에서 직접 한다. 기본 계정
  `user` / `user1234`는 알려진 POC credential이므로 외부 공개 전에 바꿔야 한다.
- **migration은 앞으로만 간다.** down/rollback 스크립트가 없다. 되돌리는 방법은
  역방향 migration을 새로 추가하는 것이다. 지금까지의 migration은 전부 추가만 하므로
  이전 버전 애플리케이션도 같은 DB에서 그대로 동작한다.
- **`updated_at`을 갱신하는 트리거가 없다.** `users.updated_at`은 행 생성 시각으로
  시작하고, 사용자 정보를 바꾸는 코드가 직접 갱신해야 한다. 지금은 그런 코드가 없다.
- **만료된 세션 행을 지우지 않는다.** 7일이 지나면 인증에 실패하지만 `auth_sessions`
  행은 남는다. 로그인 1회에 1행이 늘어나는 테이블에 정리 작업을 붙이지 않았다.
- **후속 질문은 그 문장만으로 검색한다.** 대화 맥락은 답변 생성에는 전달되지만
  임베딩에는 들어가지 않는다. "그 부서는?" 같은 질문은 그 단어들로만 검색된다.
  검색어 재작성은 LLM 호출이 하나 더 늘고 retrieval semantics 변경이라 넣지 않았다.
- **요약은 한 번의 호출이다.** 회의록 전체를 한 요청에 넣으므로, 모델 컨텍스트를 넘길
  만큼 긴 회의는 품질이 떨어지는 게 아니라 실패한다.
- **개발 환경은 CPU 추론.** 로컬 GPU(GTX 1050 Ti)는 가용 VRAM이 부족하고
  설치된 드라이버(CUDA 12.6)가 배포된 torch 빌드보다 낮아 CPU/int8로 동작시켰다.
  `WHISPER_DEVICE=cuda`로 GPU 호스트에서는 그대로 GPU를 쓴다.

---

## 14. 향후 확장

- **승인된 회의의 재검토** — `COMPLETED` → `REVIEW_REQUIRED` 복귀 경로.
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
