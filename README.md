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
| RAG 검색 | 전체 회의 / 선택한 복수 회의 범위. 계층마다 dense(BGE-M3+pgvector) + lexical(Kiwi+PostgreSQL FTS) 후보를 RRF로 융합, Top-K 6 |
| LLM 답변 | OpenAI Chat Completions (최종 답변 생성 전용) |
| 근거 표시 | 기본 접힘 → `근거 N개 보기`로 펼침. 회의명 · 화자 · timestamp · 원문 chunk |
| Web UI | React + TypeScript SPA (Vite 빌드, FastAPI가 같은 origin에서 서빙) |
| **HITL 검토 게이트** | 승인 전까지 chunk/embedding 자체를 만들지 않음 |
| POC 로그인 | username/password + 서버 세션. 사용자별 대화 이력 분리 전용 |
| 대화형 챗봇 | 대화 저장·재열람·삭제, 직전 대화 맥락 유지 |
| 검색 범위 지정 | 회의명 검색·기간 필터 모달, 복수 회의 선택, 대화별 저장 |
| 회의 요약 | 승인된 회의 대상 핵심 요약 / 주요 논의 / 결정 사항 / Action Items |
| AI 후보정 | 검토 단계에서 STT 오인식 후보 제안 (자동 저장·자동 승인 없음) |
| Docker 배포 | 단일 애플리케이션 이미지 + compose |
| DB 스키마 관리 | `scripts/migrations/*.sql` + 명시적 migration 명령 (기동 시 DDL 없음) |
| Meeting Intelligence | 승인된 회의록에서 요청·결정·Action Item·요청자·담당자·기한을 구조화 (`meeting_facts`) |
| UI 표기 | 화면은 한국어 라벨을 쓴다 — Meeting Intelligence=**회의 인사이트**, REQUEST=**요청**, DECISION=**결정**, ACTION_ITEM=**할 일**, 재임베딩=**검색 인덱스 다시 생성**. API·DB 이름은 그대로다 |
| 관계·시간 기반 검색 | "누가 요청했어" · "누가 맡았어" · "기한은" · "내가 요청한 것" · 회의 간 결정 변화 |
| Hybrid 검색 | Kiwi 형태소 → `tsvector` + GIN, RRF 융합, metadata boost. 평가 세트 44문항으로 BEFORE/AFTER 측정 (`python -m scripts.evaluate`) |
| 근거 검증 | fact는 `source_segment_ids` + `source_text` 필수, chunk도 `source_segment_ids` 보유. 모델이 만든 `[N]` 인용은 서버가 범위 검증 |
| 회의 간 충돌 | 같은 역할·다른 사람·다른 회의를 서버가 감지해 "회의별로 나누어 제시" 지시 |

---

## 2. Architecture

```
        브라우저 (React + TypeScript SPA · 같은 origin)
                  │
                  ▼
        (배포 단계) python -m scripts.migrate → schema_migrations
                  │  기동은 스키마를 만들지 않고 적용 여부만 읽기 전용으로 확인한다
                  ▼
        FastAPI (app/main.py)
        ├── require_login   로그인 API를 뺀 /api/* 전부 차단 (401)
        ├── /api/auth       로그인 · 로그아웃 · 현재 사용자
        ├── (그 외 경로)    frontend/dist — SPA 진입점과 해시 asset
        ├── /api/meetings   업로드 · 목록 · 상세 · 상태 · 회의록 수정 · 승인
        │                   · 재임베딩 · 삭제 · 요약 · AI 후보정
        │                   · 화자↔사용자 지정 · 회의 일시 · 카테고리 지정
        │                   · Meeting Intelligence
        ├── /api/meeting-categories  카테고리 목록/생성/이름 변경/삭제
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
        chunking (utterance 단위) → BGE-M3 embedding + Kiwi lexemes
                  │   ▲
                  │   └── POST /api/meetings/{id}/reindex (재임베딩)
                  │       승인된 회의록으로 이 구간만 다시 실행
                  │
                  ├── Meeting Intelligence (승인 직후 별도 백그라운드 작업)
                  │   승인된 회의록 → OpenAI 구조화 추출 → 검증 → BGE-M3
                  │   → meeting_facts + 참여자 역할
                  │   실패해도 승인·인덱싱·검색에는 영향이 없다
                  ▼
        PostgreSQL 16 + pgvector 0.8.2  (schema: minutes)
                  │
                  ▼
        질의 분석 → fact 계층 · chunk 계층 (같은 범위 규칙)
                     각 계층마다 dense + lexical → RRF → metadata
                  ──►  OpenAI  ──►  answer + sources
```

DB는 새로 띄우지 않는다. 기존 `didim_api` 인스턴스에 `minutes` schema만 추가한다.

---

## 3. 사용 기술

| 영역 | 선택 |
|---|---|
| Backend | Python 3.11, FastAPI, uvicorn |
| Frontend | React 19 + TypeScript (strict) + Vite 8, Tailwind CSS 4 |
| Frontend 상태 | TanStack Query (server state) · React Router (route state) |
| Frontend 접근성 | Radix UI Dialog primitive, lucide 아이콘, sonner 토스트 |
| Audio | FFmpeg (`imageio-ffmpeg` 정적 바이너리 fallback 포함) |
| STT | faster-whisper 1.1.1 |
| Diarization | pyannote.audio 4.0 |
| Embedding | sentence-transformers, BAAI/bge-m3 |
| Vector store | PostgreSQL 16 + pgvector 0.8.2 |
| 한국어 형태소 분석 | kiwipiepy 0.23.2 (LGPL v3, 모델이 wheel에 포함 — 런타임 다운로드 없음) |
| Lexical search | PostgreSQL FTS (`tsvector` + GIN, `ts_rank_cd`) |
| Rank fusion | RRF (Reciprocal Rank Fusion), 직접 구현 ~30줄 |
| DB driver | psycopg 3 (ORM 없음, 원시 SQL) |
| LLM | OpenAI Chat Completions |

RAG는 LangChain / LlamaIndex 없이 직접 구현했다. 검색·프롬프트·근거 직렬화가
각각 함수 하나 수준이라 프레임워크를 넣을 이유가 없었다. Hybrid 검색을 위해
OpenSearch / Elasticsearch도 넣지 않았다 — `tsvector` + GIN이 그 제품들이 쓰는
것과 같은 역색인이고, 이미 이 데이터베이스에 있다.

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

**형태소 분석은 dense 임베딩 앞단에 넣지 않는다.** BGE-M3는 자체 subword
tokenizer를 쓰는 dense 모델이라, 형태소로 쪼갠 문장을 넣으면 입력 분포가 망가진다.
chunk 본문은 사람이 읽는 그대로 임베딩한다.

형태소 분석은 **lexical 색인에만** 쓴다(§6-3). 같은 `content`에서 Kiwi로 검색용
표현을 따로 만들어 별도 컬럼에 넣는 것이고, 원문을 바꾸지 않는다.

chunk 크기는 감으로 바꾸지 않았다. 측정한 결과(`python -m scripts.evaluate
--chunking`) 평가 코퍼스의 fact 24개 전부가 **하나의 chunk 안에** 근거를 가지고
있었고, 실제 회의록의 발화가 평균 18자 정도로 짧아 token 상한보다 **발화 수 상한
7개가 먼저** chunk를 닫는다. 바꿀 근거가 측정되지 않아 바꾸지 않았다.

---

## 6. RAG 구조

### 색인 (승인 이후)

```
                 승인된 transcript_segments          ← 유일한 진실
                            │
                  speaker-aware chunking
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
             BGE-M3                    Kiwi
          dense 1024-d          형태소 → 검색용 표현
                │                       │
                ▼                       ▼
           pgvector(HNSW)      tsvector(GIN, 'simple')
        chunks.embedding          chunks.lexemes
      meeting_facts.embedding   meeting_facts.lexemes
```

한 chunk의 vector와 lexemes는 **같은 INSERT 문**에서 쓰인다
(`pipeline.index_transcript`). fact도 같다(`intelligence.store`). 서로 다른
버전의 텍스트를 가리킬 수 없다. `lexeme_tsv`는 `GENERATED ALWAYS` 컬럼이라
애플리케이션이 아예 쓸 수 없다.

### 검색 (질문 이후)

```
                        사용자 질문
                            │
              질의 분석 (1회 JSON 호출, 실패해도 계속)
              ├ 독립 질의   "그거 언제까지야?" → "SSL 인증서 발급은 언제까지야?"
              ├ fact 종류   REQUEST / DECISION / ACTION_ITEM
              ├ 참여자 역할 REQUESTER / ASSIGNEE / DECIDER
              └ 본인 지칭   "내가 …"
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
  meeting_facts 계층                       chunks 계층
  ┌────────────┬────────────┐        ┌────────────┬────────────┐
  │  dense     │  lexical   │        │  dense     │  lexical   │
  │  cosine    │ ts_rank_cd │        │  cosine    │ ts_rank_cd │
  │  Top 30    │  Top 30    │        │  Top 30    │  Top 30    │
  └──────┬─────┴─────┬──────┘        └──────┬─────┴─────┬──────┘
         └─────RRF────┘                     └─────RRF────┘
               │  1/(60 + rank) 합산               │
        metadata 일치 (+1/61)             metadata 일치 (+1/61)
        화자 이름 · 회의명 · 개최일        화자 이름 · 회의명 · 개최일
               │                                   │
          Top-K 6 → 회의 날짜순              Top-K 6 → 점수순
               └────────────────┬──────────────────┘
                                ▼
                   승인된 원문 확인 (fact는 source_text,
                   chunk는 content — 근거 없는 주장은 없다)
                                │
                   충돌 감지 (같은 역할·다른 사람·다른 회의)
                                │
                        번호 붙인 근거 블록
                                ▼
                             OpenAI
                                │
                   citation 검증 ([N] 범위 밖 제거)
                                ▼
              answer + sources(회의 · 화자 · timestamp · 원문)
```

네 갈래 검색(dense chunk / lexical chunk / dense fact / lexical fact) 모두
**같은 검색 범위 규칙**을 따르고, 각 쌍은 하나의 쿼리 빌더를 공유해서 범위
조건이 글자 그대로 동일하다. 질의 분석이 실패하면(키 없음, JSON 깨짐, 알 수 없는
값) 입력한 문장 그대로 검색하는 기존 동작으로 되돌아간다.

### 6-1. 대화 맥락

직전 대화 `rag.HISTORY_MESSAGES`(10)개를 system 프롬프트와 근거 사이에 그대로 넣는다.
요약이나 memory framework는 쓰지 않는다.

```
User      어음으로 분류된 건 어느 부서 협조가 필요해?
Assistant 재무지원실입니다. [1]
User      그 부서는 어떤 기준으로 기록한다고 했지?   ← "그 부서" = 재무지원실
```

검색 질의는 대화 맥락을 반영해 **독립 질의로 재작성한 뒤** 임베딩한다.
답변 생성에는 **사용자가 입력한 원문 그대로** 전달한다 — 재작성은 검색을 돕기 위한
것이지 질문을 바꾸는 것이 아니다. 재작성이 불가능하거나 실패하면 원문을 그대로 쓴다.
재작성이 검색 범위를 바꾸는 일은 없다.

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

### 6-3. 왜 dense만으로는 부족한가

측정에서 드러난 실패는 하나였다. `해야 할 일이 뭐야?` / `남은 작업이 뭐야?` 같은
질문은 정답과 **공통 단어가 하나도 없다.** BGE-M3 입장에서는 "무엇을 하겠다"는
문장이 전부 비슷한 거리에 있어서, 정답이 7위·10위로 밀렸다(hit@3 0.000).

반대로 `Redis 6379 포트`, `월 350만원`, `PostgreSQL 16`처럼 **정확한 토큰**이
핵심인 질문은 dense가 이미 잘 찾지만 구조적으로 보장되지 않는다. 임베딩은 숫자
`6379`를 특별히 우대할 이유가 없다.

Kiwi는 조사·어미를 떼고 검색에 쓰이는 형태만 남긴다.

```
최광훈 대리가 SSL 인증서를 발급하기로 했습니다.
        ↓
최광훈 대리 ssl 인증서 발급
```

`인증서를` · `인증서가` · `인증서는`이 모두 `인증서`로 색인되므로, 형태소 분석 없이
`to_tsvector`를 그냥 쓰면 하나도 매칭되지 않던 것이 매칭된다.

**점수를 더하지 않고 순위를 더한다.** cosine 유사도와 `ts_rank_cd`는 척도가 달라서
`0.7 * dense + 0.3 * lexical` 같은 가중합에서 상수는 근거 없는 추측이 된다. RRF는
순위만 읽는다.

```
score(d) = Σ  1 / (60 + rank of d in that axis)
```

`60`은 RRF 원논문(Cormack et al., 2009)의 값이고, 10 / 20 / 60 / 120으로 sweep한
결과 모든 지표가 동일해서 튜닝할 근거가 없었다.

### 6-4. Metadata는 boost만 한다

질문이 회의·화자·날짜를 지목하면 해당 후보의 순위 점수에 RRF 한 자리분
(`1/61`)을 더한다. **후보를 제거하지는 않는다** — 엔티티 추정은 hard filter로
쓸 만큼 정확하지 않다. 확실한 hard filter는 UI가 지정한 검색 범위 하나뿐이다.

방향이 중요하다. 질문에서 엔티티를 뽑아 신뢰하는 것이 아니라, **후보 행이 DB에
가지고 있는 값**을 질문에 실제로 등장했는지 확인한다. 그래서 "화자"는 항상 그
회의에 실재하는 화자이고, "날짜"는 항상 그 회의의 실제 개최일이다.

| 신호 | 인정 조건 |
|---|---|
| 화자 | 저장된 표시명의 **모든** 형태소가 질문에 있음 (`김 대리`가 `대리`만으로 매칭되지 않게) |
| 회의 | 회의명 형태소의 **절반 이상**이 질문에 있음 |
| 개최일 | 질문에 **월과 일이 모두** 있고, 그 회의에 `held_at`이 실제로 입력돼 있음 |

`held_at`이 NULL인 회의는 날짜 신호를 받지 않는다. 아무도 입력하지 않은 날짜는
등록일이고, 개최일을 묻는 질문의 답이 될 수 없다.

### 6-5. 측정 결과

`python -m scripts.evaluate`. 회의 9개(6개는 작성, 3개는 실제 DB의 meeting 1 · 2 ·
525 회의록을 STT 잡음까지 그대로 복사) · 발화 83개 · fact 24개 · 질문 44개(정답이
있는 것 41개), 실제 BGE-M3와 실제 Kiwi로 throwaway `minutes_eval` 스키마에서 측정.

| mode | hit@1 | hit@3 | hit@5 | MRR | meeting@5 | ms/query |
|---|---|---|---|---|---|---|
| dense (기존) | 0.854 | 0.927 | 0.927 | 0.896 | 0.927 | 230 |
| lexical only | 0.756 | 0.927 | 0.951 | 0.848 | 0.951 | 60 |
| hybrid | 0.805 | 0.976 | 1.000 | 0.891 | 1.000 | 308 |
| **hybrid+meta (현재)** | **0.829** | **1.000** | **1.000** | **0.911** | **1.000** | 285 |

hit@1이 0.854 → 0.829로 떨어진 것은 숨기지 않는다. 4개 질문에서 정답이 1위에서
2~3위로 내려갔고, 이것은 RRF의 통상적인 trade(1위 선명도 ↔ recall)다. 여기서
받아들이는 이유는 검색된 근거는 전부 모델에 전달되지만 **7위·10위는 Top-K 6을
넘기지 못하기** 때문이다.

질문 유형별로는 `action_item`이 hit@3 0.000 → 1.000, `metadata`가 MRR 0.619 →
0.833으로 올랐고, 나빠진 유형은 없다.

**no-answer 정확도와 충돌 답변은 측정하지 못했다.** 둘 다 생성 단계 지표이고,
개발 환경의 `OPENAI_API_KEY`가 401 `invalid_organization`을 반환한다. 0점이
아니라 **미측정**이다. 프롬프트 규칙과 서버측 충돌 감지는 stub 모델로 테스트되어
있어, 모델에게 무엇을 보여주고 무엇을 지시하는지는 고정돼 있다.

### 6-6. Grounding · citation · 충돌

- **근거 없는 주장은 없다.** fact는 `source_text`(그 사실이 나온 발화 원문)를
  항상 함께 들고 다닌다. LLM이 추출한 `담당자 = 최광훈`을 그대로 답으로 쓰지
  않고, 승인된 원문을 같이 보여준 상태로만 생성한다.
- **없는 근거를 인용하면 지운다.** 모델이 쓴 `[N]`이 실제로 전달한 근거 개수를
  벗어나면 그 표시만 제거한다(`rag.validate_citations`). 문장은 고치지 않는다 —
  모델이 쓴 문장을 애플리케이션이 다시 쓰는 것은 두 번째 창작이다.
- **회의마다 답이 다르면 하나를 고르지 않는다.** `rag.has_conflict`가 검색된
  행에서 *같은 역할 · 다른 사람 · 다른 회의 · 겹치는 주제*를 찾으면 근거 뒤에
  "회의별로 나누어 각각 제시하라"는 지시를 덧붙인다. 판단을 모델에게 묻지 않고
  데이터에서 계산한다.

- **승인된(`COMPLETED`) 회의만 검색한다.** 승인 전 회의는 애초에 chunk가 없고,
  질의 조건에도 status 필터가 걸려 있다.
- 검색 범위: `chat_sessions.scope_meeting_ids`가 비어 있으면 전체 회의,
  값이 있으면 **그 회의들만** (`meeting_id = ANY(...)`). chunk 검색과 fact 검색에
  **똑같이** 적용된다.
- 거리 연산자는 `<=>` (cosine). 임베딩은 정규화해서 저장한다.
- 프롬프트는 근거 블록만 사용하도록 제한하고, 근거로 답할 수 없으면
  "회의록에서 해당 내용을 찾지 못했습니다."만 답하도록 지시한다.
- 응답의 `sources[]`에는 회의 ID·회의명·화자·시작/종료 timestamp·원문 chunk·유사도가 들어간다.
- **화면에 몇 개를 보여주는지와 몇 개가 있는지는 별개다.** 검색은 두 계층 각각
  Top-K 6, 답변 생성 프롬프트는 검색된 근거 전부, 응답 `sources[]`와
  `chat_messages.sources`도 전부를 담는다. 화면은 기본적으로 근거를 **하나도**
  펼치지 않고 개수만 밝히며(`근거 N개 보기`), 펼치면 검색된 전부를 원문 그대로
  보여준다. 근거를 버리는 코드는 없고, 펼친 원문을 자르지도 않는다.
- LLM 호출이 실패해도 검색 결과(근거)는 그대로 반환한다.
---

## 7. DB Schema (`minutes`)

| 테이블 | 내용 |
|---|---|
| `meetings` | id, title, original_filename, stored_filename, duration, language, status, error_message, `held_at`(실제 개최 일시, NULL 가능), `category_id`(FK, NULL=미분류), created_at(업로드 시각) |
| `speakers` | id, meeting_id, speaker_code, display_name — `(meeting_id, speaker_code)` unique |
| `transcript_segments` | id, meeting_id, speaker_id, sequence, start_time, end_time, text |
| `chunks` | id, meeting_id, sequence, content, start_time, end_time, speaker_codes[], `source_segment_ids BIGINT[]`(007 이전 행은 NULL), `lexemes`(Kiwi 형태소 문자열), `lexeme_tsv tsvector`(GENERATED, GIN), embedding `vector(1024)` |
| `meeting_summaries` | meeting_id (PK·FK cascade), content, created_at — 회의당 1행 |
| `meeting_categories` | id, name (unique), created_at, updated_at — 회의 분류 라벨 (평면 구조 — 트리도 태그도 아니다). 삭제하면 `meetings.category_id`가 `ON DELETE SET NULL`로 널이 되고 회의는 남는다 |
| `users` | id (내부 PK), username (로그인 ID, unique), password_hash (scrypt), display_name, is_active, created_at, updated_at, last_login_at |
| `schema_migrations` | version (PK), name, applied_at — 적용된 migration 기록 |
| `auth_sessions` | id (쿠키에 담기는 불투명 토큰), user_id, created_at |
| `chat_sessions` | id, user_id, title, `scope_meeting_ids BIGINT[]` (비어 있으면 전체), created_at, updated_at |
| `chat_messages` | id, session_id, role, content, `sources JSONB`, created_at |
| `meeting_facts` | id, meeting_id, fact_type(REQUEST=남에게 해달라고 요청 / DECISION=회의에서 확정된 결정 / **ACTION_ITEM=말한 사람 자신이 하겠다고 명시적으로 약속·수락한 것**), content, status(UNKNOWN 기본/OPEN/DONE/CANCELLED/DEFERRED), deadline_text, deadline_at, start_time, end_time, `source_segment_ids BIGINT[]`, source_text, `lexemes`, `lexeme_tsv tsvector`(GENERATED, GIN), embedding `vector(1024)` |
| `meeting_fact_participants` | fact_id, speaker_id, role(REQUESTER/ASSIGNEE/DECIDER) — PK 3열 |
| `meeting_user_speakers` | meeting_id, user_id, speaker_id, created_at — 로그인 사용자가 그 회의의 누구인지 |

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
- `meeting_facts.source_segment_ids`에는 `CHECK (cardinality(...) > 0)`이 걸려 있다.
  **근거 없는 fact는 DB가 거부한다.**
- `meeting_user_speakers`는 `(speaker_id, meeting_id) → speakers (id, meeting_id)`
  복합 FK를 쓴다. 다른 회의의 화자를 지정하는 것은 애플리케이션 코드가 아니라 DB가 막는다.
- fact 추출 상태는 `meetings.intelligence_state`(NOT_BUILT/BUILDING/READY/FAILED)에 있고
  **`meetings.status`와 별개다.** 추출이 실패해도 승인된 회의는 그대로 검색된다.
- `lexeme_tsv`는 `GENERATED ALWAYS AS (to_tsvector('simple', lexemes)) STORED`다.
  애플리케이션이 쓸 수 없으므로 색인이 원본 문자열과 어긋날 수 없다. `'simple'`을
  명시한 이유는 두 인자 형태만 `IMMUTABLE`이라 generated 컬럼에 쓸 수 있기 때문이고,
  형태소 분해는 이미 Kiwi가 했으므로 한국어를 모르는 내장 설정을 쓸 이유도 없다.
- `chunks.source_segment_ids`는 nullable이고 CHECK도 없다. migration 007 이전에
  쓰인 행에는 채울 id가 없고, **만들어 넣는 것이 없는 것보다 나쁘다.** 그 회의를
  재임베딩하면 채워진다.
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

프런트엔드는 별도 서버가 아니라 FastAPI가 서빙하는 정적 빌드다. 위 명령만으로는
`frontend/dist`가 없어 페이지가 `503`이므로, 로컬에서는 한 번 빌드해 두거나
(`cd frontend && npm ci && npm run build`) 아래 개발 서버를 쓴다.

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173, /api 와 /health 는 8000으로 프록시
```

`vite.config.ts`의 dev proxy가 개발 중에도 같은 origin을 재현하므로 CORS 설정은
백엔드 어디에도 없다. 운영은 애초에 한 origin이다.

| 명령 (`frontend/`) | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 + API 프록시 |
| `npm run typecheck` | `tsc -b` (strict) |
| `npm run lint` | ESLint (typescript-eslint + react-hooks) |
| `npm test` | Vitest + React Testing Library |
| `npm run e2e` | Playwright 브라우저 스모크 (production 번들 대상) |
| `npm run build` | `tsc -b && vite build` → `frontend/dist` |

화면:

- 로그인 : `/login`
- 회의 목록 / 업로드 : `/`
- 회의 상세 (개요 · 회의록 · 인사이트 탭) : `/meetings/{id}`
- 채팅 : `/chat`, `/chat/{sessionId}`

모두 client-side route다. 새로고침하거나 딥링크로 바로 열어도 FastAPI가 SPA 진입점을
돌려주고 React Router가 경로를 해석한다. `/api/*`는 이 fallback에 걸리지 않는다 —
없는 API는 페이지가 아니라 `404`다.

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

- `tests/test_core.py` — 순수 로직 8개. 모델도 DB도 쓰지 않는다.
- `tests/test_migrate.py` — migration runner 20개.
- `tests/test_hitl.py` — 승인 게이트·재임베딩·삭제 23개.
- `tests/test_auth.py` — 인증 경계 16개.
- `tests/test_chat.py` — 대화 소유권·multi-turn·검색 범위·이름 변경 24개.
- `tests/test_assist.py` — 요약·AI 후보정 12개.
- `tests/test_intelligence.py` — fact 추출·ACTION_ITEM recall·검증·상태·기한·rebuild 원자성·화자 지정·회의 일시 52개.
- `tests/test_retrieval.py` — 관계·시간·후속 질문·commitment 질의 검색 22개.
- `tests/test_hybrid.py` — Kiwi 형태소·RRF fusion·metadata 일치·citation 검증·충돌
  감지·네 갈래 검색의 범위 불변식·lexical backfill 50개.
- `tests/test_frontend.py` — SPA/API 라우팅 우선순위, 딥링크, 경로 traversal, 번들 secret 검사 13개.
- `tests/test_categories.py` — 카테고리 CRUD·중복·회의 지정·삭제 시 회의 보존, 업로드 `held_at` 15개.

migration 테스트만은 `minutes`가 아니라 `minutes_test_<random>` 임시 schema를 만들어
쓰고 끝나면 지운다. 실제 회의 데이터가 있는 schema에는 fresh-DB migration을 시험할 수 없기
때문이다. 나머지 DB 테스트는 실제 `minutes` schema에 접속하고, 임베딩·fact 추출·OpenAI만
가짜로 대체한다. 자기 회의·자기 계정만 만들고 끝나면 지운다. DB에 접속할 수 없으면 skip된다.

프런트엔드 테스트는 `frontend/`에서 따로 돌린다.

```bash
cd frontend
npm test          # Vitest 92개 - 인증·앱 셸·목록/필터·업로드·상세·HITL·인사이트
                  #               ·채팅·이름 변경·근거 표시·검색 범위·카테고리 관리
                  #               ·승인 전 안내 상태·라우팅
npm run e2e       # Playwright 12개 - 실제 Chromium에서 production 번들 스모크 (1024 포함)
```

Vitest는 `fetch`를 라우트 표로 대체해서 API 경계만 흉내 낸다(mock 서버 의존성 없음).
Playwright는 `vite preview`가 서빙하는 **실제 빌드 산출물**을 브라우저로 열고 API만
가로채므로 DB도 모델도 계정도 필요 없다.

### 검색 품질 평가

테스트는 동작을 고정하고, 평가는 품질을 **측정**한다. 둘은 다른 도구다.

```bash
.venv/bin/python -m scripts.evaluate                    # 네 mode 전부, 검색 지표
.venv/bin/python -m scripts.evaluate --detail           # 질문별 정답 순위
.venv/bin/python -m scripts.evaluate --chunking         # chunk 형태와 fact 분절 여부
.venv/bin/python -m scripts.evaluate --rrf-k 20 --rrf-k 60   # 상수 sweep
.venv/bin/python -m scripts.evaluate --generation       # 답변 단계(LLM 키 필요)
```

- throwaway `minutes_eval` schema를 만들고 끝나면 지운다. 실제 `minutes` schema는
  **열지 않는다** — connection pool이 이미 열려 있으면 실행을 중단한다.
- 임베딩은 실제 BGE-M3, 형태소는 실제 Kiwi다. stub을 쓰면 stub을 측정하게 된다.
- 검색 지표는 `rag.plan`(질의 재작성)을 일부러 건너뛴다. LLM 출력이 실행마다 달라지면
  네 mode를 비교할 수 없다.
- `--generation`은 LLM 호출이 실패하면 FAIL이 아니라 **SKIP**으로 보고한다. 키가
  고장난 것을 모델이 틀린 것으로 기록하지 않기 위해서다.

평가 세트는 `scripts/eval_data.py`에 있고, 질문마다 정답 회의와 **정답 발화 id**가
적혀 있다.

### lexical 색인 보정

```bash
.venv/bin/python -m scripts.backfill_lexemes         # lexemes가 없는 행만
.venv/bin/python -m scripts.backfill_lexemes --all   # 전부 재계산
```

이미 embedding이 있는 기존 회의를 **재임베딩 없이** lexical 검색 대상으로 만든다.
BGE-M3도 LLM도 로드하지 않는다. 재임베딩(`POST /api/meetings/{id}/reindex`)과
책임이 다르다: 재임베딩은 chunk를 다시 만들고 1024차원 vector를 다시 쓰는 비싼
작업이고, 이것은 이미 저장된 텍스트에서 한 컬럼만 채운다.

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
| `POST` | `/api/meetings` | multipart `file`, `title`, `held_at`(선택, ISO8601 또는 빈 문자열). 즉시 응답하고 백그라운드로 분석 |
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
| `PUT` | `/api/meetings/{id}/held-at` | `{"held_at": ISO8601 \| null}` — 실제 회의 일시. 시간순 정렬과 상대 기한의 기준 |
| `PUT` | `/api/meetings/{id}/me` | `{"speaker_id": n \| null}` — 로그인 사용자가 이 회의의 어느 화자인지 지정/해제 |
| `PUT` | `/api/meetings/{id}/category` | `{"category_id": n \| null}` — 카테고리 지정/해제 (null = 미분류) |
| `GET` | `/api/meetings/{id}/intelligence` | 추출 상태 + fact 목록(참여자·기한·근거 발화 포함) |
| `POST` | `/api/meetings/{id}/intelligence/rebuild` | fact 재추출 (`COMPLETED` 전용) |
| `GET`/`POST` | `/api/meeting-categories` | 카테고리 목록(회의 수 포함) / 생성. 같은 이름은 `409` |
| `PATCH`/`DELETE` | `/api/meeting-categories/{id}` | 이름 변경 / 삭제. **삭제해도 회의는 남고 미분류가 된다** |
| `POST` | `/api/auth/login` · `/api/auth/logout` | 로그인 / 로그아웃 |
| `GET` | `/api/auth/me` | 현재 로그인 사용자 (`{id, username, display_name}`) |
| `GET`/`POST` | `/api/chat/sessions` | 내 대화 목록 / 새 대화 |
| `GET`/`PATCH`/`DELETE` | `/api/chat/sessions/{id}` | 대화 + 메시지 / 검색 범위 변경 / 삭제 |
| `PATCH` | `/api/chat/sessions/{id}/title` | `{"title": "..."}` — 대화 이름 변경. 공백은 `400`, 40자 초과는 자동 절단 |
| `POST` | `/api/chat/sessions/{id}/messages` | `{question, global_override, top_k}` → `{answer, sources[], scope_miss}` |
| `GET` | `/health` | 헬스체크 |

`POST /api/auth/login`을 뺀 모든 `/api/*`는 세션이 필요하고, 없으면 `401`이다.
`/health`와 SPA 진입점은 공개다 — 진입점은 누구에게나 같은 바이트이고 사용자 정보를
담지 않는다. 로그인 여부는 브라우저가 `/api/auth/me`로 물어보고, `401`이면 React Router가
`/login`으로 보낸다. 즉 경계는 페이지가 아니라 API에 있다.

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

Meeting Intelligence 상태는 `meetings.intelligence_state`에 따로 있고 위 흐름과 무관하다.

```
NOT_BUILT ──► BUILDING ──► READY
                  └──────► FAILED ──► BUILDING (재생성)
```

추출이 `FAILED`여도 회의는 `COMPLETED` 그대로이고 검색도 정상 동작한다. 이것이 컬럼을
분리한 이유다.

---

## 11. 오픈소스 모델

| 용도 | 모델 | 라이선스 |
|---|---|---|
| STT | `Systran/faster-whisper-medium` (OpenAI Whisper 변환본) | MIT |
| 화자 분리 | `pyannote/speaker-diarization-community-1` | gated, 사용 조건 동의 필요 |
| 임베딩 | `BAAI/bge-m3` (1024-dim, 다국어/한국어) | MIT |
| 한국어 형태소 분석 | `kiwipiepy` 0.23.2 + `kiwipiepy_model` 0.23.0 | LGPL v3 |

BGE-M3를 그대로 채택했다. 로컬 CPU에서 chunk 임베딩이 chunk당 수십 ms 수준이라
더 작은 모델로 낮출 이유가 없었다.

Kiwi는 모델이 pip wheel(`kiwipiepy_model`, 약 105 MB) 안에 들어 있어 **런타임
다운로드가 없다.** 라이선스가 LGPL v3이므로 라이브러리로 import해서 쓰고 수정하지
않는다. 이미지 크기는 약 106 MB 늘어난다.

**별도 reranker 모델은 넣지 않았다.** 이 서버는 CPU이고 이미 Whisper · pyannote ·
BGE-M3 세 모델을 로드한다. 평가에서 hit@5가 1.000이므로 reranker가 이 코퍼스에서
더 찾아낼 것이 없다 — 근거 없이 네 번째 무거운 모델을 올리지 않는다.

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
- **검색 품질은 측정했지만, 측정에도 한계가 있다.** 평가 코퍼스는 발화 83개다.
  hit@5가 1.000인 것은 검색이 완성됐다는 뜻이 아니라 **코퍼스가 작다**는 뜻이고,
  실제 코퍼스에서 개선되는 변경이 여기서는 변화 없이 보일 수 있다. 반대로 여기서
  나빠지는 변경은 실제로도 나쁠 가능성이 높다.
- **no-answer 정확도와 충돌 답변 품질은 미측정이다.** 둘 다 생성 단계 지표이고 개발
  환경 `OPENAI_API_KEY`가 401을 반환한다. 프롬프트 규칙과 서버측 충돌 감지는 stub
  모델로 테스트돼 있으나, 실제 모델이 그 지시를 얼마나 따르는지는 확인되지 않았다.
- **`ts_rank_cd`에는 IDF가 없다.** 모든 chunk에 나오는 단어를 질의 시점에 낮춰줄 수가
  없어서, 색인 시점에 stopword로 빼는 방식으로 완화한다. BM25가 필요할 만큼 흔한
  토큰이 문제가 되는지는 더 큰 코퍼스에서 확인해야 한다.
- **hit@1은 dense 단독보다 조금 낮다** (0.854 → 0.829). RRF가 1위 선명도를 recall과
  바꾼 결과이고, 검색된 근거가 전부 모델에 전달되기 때문에 받아들였다.
- **`chunks.source_segment_ids`는 migration 007 이전 행에서 NULL이다.** 저장된 chunk의
  렌더링된 텍스트에서 원래 발화 id를 복원할 수 없어서 backfill하지 않는다. 필요하면
  그 회의를 재임베딩해야 한다.
- **metadata 신호는 세 개뿐이다.** 화자 표시명·회의명·개최일. 카테고리는 검색에 쓰지
  않고, "지난주", "3분기" 같은 상대 기간 표현도 해석하지 않는다.
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
- **프런트엔드는 다크 모드가 없다.** 디자인 토큰은 한 곳(`frontend/src/index.css`)에
  모여 있어 추가 비용은 크지 않지만, 이번에는 라이트 모드 하나의 완성도를 우선했다.
- **프런트엔드에 실시간 전송이 없다.** 목록 3초, 회의 상세 2초, 인사이트 생성 중 3초
  폴링이다. SSE/WebSocket은 현재 규모에서 얻는 것이 없다.
- **업로드는 한 번에 한 파일이다.** 여러 파일을 끌어다 놓으면 첫 번째만 올라간다.
- **회의 목록 필터는 브라우저에서 돈다.** 검색어·카테고리·상태·기간 필터와 정렬은
  `GET /api/meetings`가 준 전체 배열 위에서 계산된다. 페이지네이션이 없으므로 목록이
  한 요청에 담기지 않을 규모가 되면 서버 쿼리가 먼저 필요하다.
- **카테고리는 회의당 하나이고 트리도 태그도 아니다.** 다중 분류와 중첩은 이번 범위
  밖이다. 카테고리는 사람이 회의를 고르는 라벨일 뿐, 검색·파이프라인이 읽는 필터가
  아니다. 관리 화면은 `/categories`로 분리되어 있고, 회의 목록에는 그리로 가는 조용한
  링크만 둔다.
- **대화 이름은 사람이 바꾼 뒤에는 자동으로 바뀌지 않는다.** 첫 질문이 이름을 채우는
  것은 제목이 아직 기본값 `새 채팅`일 때뿐이다. `title_source` 같은 컬럼은 없으므로,
  일부러 `새 채팅`으로 되돌린 대화는 다음 첫 질문이 다시 이름을 붙인다.
- **승인 전 화면은 아무것도 만들지 않는다.** 개요·인사이트 탭은 왜 비어 있는지와 다음에
  할 일만 보여준다. 초안 요약이나 임시 fact를 미리 만들어 두는 경로는 없다.
- **회의 일시 기본값은 제안이다.** 업로드 대화상자가 브라우저 로컬 시각의 오늘을 미리
  채워 주지만, DB에는 `DEFAULT now()`가 없고 기존 `held_at = NULL` 행을 채우지도 않는다.
  2026-08-21 기준 공용 DB의 회의 6건은 모두 여전히 `held_at = NULL`이다.
- **브라우저 스모크는 API를 가로챈 상태로 돈다.** Playwright는 실제 번들을 실제
  Chromium에서 열지만 백엔드는 스텁이다. 실제 음성·모델·DB 경로는 Human UAT다.
- **migration은 앞으로만 간다.** down/rollback 스크립트가 없다. 되돌리는 방법은
  역방향 migration을 새로 추가하는 것이다. 지금까지의 migration은 전부 추가만 하므로
  이전 버전 애플리케이션도 같은 DB에서 그대로 동작한다.
- **`updated_at`을 갱신하는 트리거가 없다.** `users.updated_at`은 행 생성 시각으로
  시작하고, 사용자 정보를 바꾸는 코드가 직접 갱신해야 한다. 지금은 그런 코드가 없다.
- **만료된 세션 행을 지우지 않는다.** 7일이 지나면 인증에 실패하지만 `auth_sessions`
  행은 남는다. 로그인 1회에 1행이 늘어나는 테이블에 정리 작업을 붙이지 않았다.
- **후속 질문 재작성은 OpenAI 호출을 하나 더 쓴다.** 질문마다 질의 분석 호출이 한 번
  더 나간다. 이 호출이 실패하면 조용히 원문 검색으로 되돌아가고, 응답에는 그 사실이
  드러나지 않는다.
- **요청과 수락은 별개의 fact다.** "비밀번호 남겨주세요"는 REQUEST,
  "문자로 남겨드리겠습니다"는 ACTION_ITEM이고 담당자는 그 말을 한 화자다. 둘은
  서로를 대체하지 않으며, 요청만 있고 아무도 수락하지 않았다면 ACTION_ITEM은
  만들어지지 않는다. 이 구분은 추출 프롬프트가 결정하고 validator는 관여하지 않는다.
- **fact는 추출 1회의 품질이 전부다.** `meeting_facts`는 승인된 회의록을 LLM이 한 번
  훑어 만든 것이고, fact 자체에 대한 사람 검토 단계는 없다. 검증 로직은 근거 없는
  fact와 지어낸 화자·날짜를 막을 뿐, **놓친 요청을 찾아주지는 못한다.** 빠진 fact는
  화면에도 보이지 않는다.
- **fact 상태는 추론하지 않는다.** 회의에서 완료·취소·연기·진행 중을 명시하지 않으면
  종류와 무관하게 `UNKNOWN`이다. `ACTION_ITEM`이라고 해서 `OPEN`을 기본값으로 주지
  않는다. 따라서 "아직 안 끝난 것"을 물으면 `UNKNOWN` 항목이 함께 나오고, 답변은
  그것을 미완료로 단정하지 않고 "회의에서 언급되지 않았다"로 말한다.
- **회의 간 결정 변화는 그래프가 아니라 시간순 비교다.** `SUPERSEDES` 같은 관계
  테이블이 없다. 검색된 `DECISION`을 회의 날짜 순으로 정렬해 모델이 읽는 방식이다.
- **기한 정규화는 연·월·일이 모두 확정되는 표현만 지원한다.** `오늘/내일/모레`,
  요일 표현, 그리고 `YYYY-MM-DD` / `YYYY년 M월 D일`처럼 연도가 명시된 표현만
  `deadline_at`이 채워진다. **`9월 1일까지`처럼 연도가 없는 표현은 `deadline_at`이
  NULL이다** — 어느 해인지 말한 적이 없기 때문이다. `deadline_text`는 항상 원문
  그대로 남고 화면과 근거에 표시된다.
- **회의 일시는 사람이 입력해야 한다.** 상대 기한과 회의 간 시간순은 `held_at`을
  기준으로 하고, 비어 있으면 `created_at`(업로드 시각)으로 대체된다. 대체된 경우
  화면과 근거에 `등록`이라고 표시되며 실제 개최일이라고 주장하지 않는다.
- **"나"는 회의마다 직접 지정해야 한다.** `meeting_user_speakers`는 회의별 매핑이고
  화자 목소리로 자동 인식하지 않는다. "지난달 내가 요청한 것"은 매핑을 해둔 회의만
  포함한다.
- **긴 회의의 fact 추출 비용에 상한이 없다.** 40 segment 창마다 OpenAI 요청이 하나씩
  나가고, 승인할 때마다 자동으로 실행된다. 취소 수단도 없다.
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
- **BM25 스코어링** — 현재 lexical 축은 PostgreSQL `ts_rank_cd`이고 IDF가 없다.
  흔한 토큰이 정밀도를 실제로 깎는 것이 더 큰 코퍼스에서 확인되면, 같은 `tsvector`
  위에서 문서 빈도를 반영하는 스코어링으로 바꾼다. OpenSearch로 옮기는 것이 아니라
  스코어 함수를 바꾸는 문제다.
- **Reranking** — cross-encoder 재순위화. 지금은 넣지 않았다: CPU 서버에 네 번째
  무거운 모델이고, 평가에서 hit@5가 1.000이라 더 찾을 것이 없다. hit@5가 1.0 아래로
  내려가는 코퍼스가 생기면 그때 측정해서 판단한다.
- **no-answer 임계값** — 융합이 신호를 하나 만들어 놓았다. 답이 없는 질문은 두 축이
  합의하지 못해 RRF 점수가 대략 절반(≈0.016 대 ≈0.033)이다. 하지만 임계값을 정하려면
  생성 단계 정확도를 측정해야 하고, 그 측정은 아직 불가능하다(위 "한계" 참고).
- **상대 기간 해석** — "지난주", "이번 분기" 같은 표현을 회의 개최일 범위로 바꿔
  metadata 신호에 넣는다. 현재는 월·일이 명시된 질문만 인정한다.
- **Streaming transcription** — 회의 종료 후 일괄 처리 대신 실시간 자막.
