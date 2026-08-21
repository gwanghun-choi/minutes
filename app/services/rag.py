"""Retrieval and answer generation.

Two kinds of evidence reach the model, under one scope rule:

    meeting_facts   structured - who requested, who is assigned, by when
    chunks          the transcript excerpts those facts came out of

The fact layer is additive. Remove it and this is the dense-retrieval RAG it has
always been; a question with no structured answer still gets the excerpts.
"""
import json
import logging

from app import config
from app.db import conn
from app.services import embedding, intelligence

log = logging.getLogger("minutes.rag")

# The one sentence the model is told to produce when the evidence does not
# answer the question. Reused as the miss signal, so there is no second
# threshold or relevance framework deciding the same thing differently.
NO_ANSWER = "회의록에서 해당 내용을 찾지 못했습니다."

# Bounded conversation memory: the last few turns, verbatim. No summarization
# and no memory store — a POC chat is short, and the evidence, not the history,
# is what the answer must come from.
HISTORY_MESSAGES = 10

SYSTEM_PROMPT = f"""당신은 회의록 검색 도우미입니다.
아래 [근거]에 주어진 회의록 발췌만 사용해서 한국어로 답하세요.

규칙:
- [근거]에 없는 내용은 절대 추측하거나 지어내지 마세요.
- [근거]로 답할 수 없으면 "{NO_ANSWER}"라고만 답하세요.
- 답변에는 근거로 사용한 발췌의 번호를 [1], [2] 형식으로 표시하세요.
- 이전 대화가 있으면 지시대명사("그 부서", "거기")가 무엇을 가리키는지 그 대화에서 파악하세요.
- [근거]는 회의 날짜 순으로 정렬되어 있습니다. 결정이 바뀐 과정을 물으면 그 순서대로 정리하세요.
- 담당자나 기한은 [근거]에 명시된 경우에만 말하세요. 없으면 없다고 하세요.
- 상태가 "미확인"인 항목은 완료됐다고도, 아직 안 끝났다고도 단정하지 마세요.
  회의에서 완료 여부가 언급되지 않았다고 그대로 말하세요.
- 회의 날짜에 "등록"이 붙어 있으면 실제 개최일이 아니라 시스템 등록일입니다.
- 간결하게, 핵심부터 답하세요."""

# "내가"를 물었지만 이 계정이 그 회의에서 어느 화자인지 모를 때. 추측하지 않는다.
NO_IDENTITY = (
    "질문하신 분이 회의에서 어느 화자인지 지정되어 있지 않아 확인할 수 없습니다. "
    "회의 상세 화면에서 [나로 지정]을 먼저 눌러 주세요."
)

PLAN_PROMPT = """당신은 회의록 검색 질문을 분석하는 도우미입니다.
이전 대화와 현재 질문을 보고 아래 JSON만 출력하세요.

{"query": "<검색에 사용할 독립된 질문>",
 "fact_types": ["REQUEST", "DECISION", "ACTION_ITEM"],
 "participant_role": "REQUESTER 또는 ASSIGNEE 또는 DECIDER 또는 null",
 "self_reference": true 또는 false}

규칙:
- query: 현재 질문의 지시대명사("그 부서", "그 사람", "거기")를 이전 대화에 나온 실제 대상으로
  바꿔서, 그 문장만 읽어도 무엇을 찾는지 알 수 있게 만드세요.
- 이전 대화로 알 수 없으면 현재 질문을 그대로 쓰세요.
- 이전 대화에 없는 사실을 query에 추가하지 마세요. 질문의 의미를 바꾸지 마세요.
- fact_types: 관련 있는 종류만 남기세요. 판단이 어려우면 셋 다 넣으세요.
- participant_role: "누가 요청했어"는 REQUESTER, "누가 맡았어"/"담당이 누구야"는 ASSIGNEE,
  "누가 결정했어"는 DECIDER, 해당 없으면 null.
- self_reference: 질문이 "내가", "제가", "나한테"처럼 질문한 사람 자신을 가리키면 true."""


def search(question: str, meeting_ids: list[int] | None = None, top_k: int = 6) -> list[dict]:
    """Dense Top-K over approved meetings only.

    An unapproved meeting has no chunks at all, so the status predicate below is
    defence in depth rather than the primary gate — it also excludes a meeting
    whose chunks are stale because it went back to review.

    `meeting_ids` is the chat scope: None or empty means the whole corpus, and a
    non-empty list is a hard restriction. Nothing here ever widens it.
    """
    qvec = embedding.encode_one(question)
    sql = """
        SELECT c.id, c.meeting_id, c.content, c.start_time, c.end_time,
               c.speaker_codes, m.title AS meeting_title,
               1 - (c.embedding <=> %(q)s::vector) AS score
        FROM chunks c
        JOIN meetings m ON m.id = c.meeting_id
        WHERE c.embedding IS NOT NULL
          AND m.status = 'COMPLETED'
    """
    params: dict = {"q": qvec, "k": top_k}
    if meeting_ids:
        sql += " AND c.meeting_id = ANY(%(mids)s)"
        params["mids"] = list(meeting_ids)
    sql += " ORDER BY c.embedding <=> %(q)s::vector LIMIT %(k)s"

    with conn() as c:
        rows = c.execute(sql, params).fetchall()

    # map SPEAKER_00 -> stored display name, per meeting
    found_ids = sorted({r["meeting_id"] for r in rows})
    names: dict[tuple[int, str], str] = {}
    if found_ids:
        with conn() as c:
            for s in c.execute(
                "SELECT meeting_id, speaker_code, display_name FROM speakers "
                "WHERE meeting_id = ANY(%s)",
                (found_ids,),
            ).fetchall():
                names[(s["meeting_id"], s["speaker_code"])] = s["display_name"] or s["speaker_code"]

    for r in rows:
        r["kind"] = "chunk"
        r["speakers"] = [names.get((r["meeting_id"], sc), sc) for sc in r["speaker_codes"]]
        r["score"] = round(float(r["score"]), 4)
    return rows


def plan(question: str, history: list[dict] | None = None) -> dict:
    """One call that resolves a follow-up and names what to filter facts on.

    Retrieval only. The generator always receives the question exactly as typed —
    a rewrite is a search aid, never a change to what was asked. Any failure at
    all (no key, bad JSON, an unknown enum value) falls back to the plain
    question with no filters, which is the behaviour this module had before.
    """
    fallback = {
        "query": question,
        "fact_types": list(intelligence.FACT_TYPES),
        "participant_role": None,
        "self_reference": False,
    }
    if not config.OPENAI_API_KEY:
        return fallback

    from openai import OpenAI

    try:
        resp = OpenAI(api_key=config.OPENAI_API_KEY).chat.completions.create(
            model=config.OPENAI_MODEL,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": PLAN_PROMPT},
                *(history or []),
                {"role": "user", "content": question},
            ],
        )
        raw = json.loads(resp.choices[0].message.content)
    except Exception as exc:
        log.warning("query planning failed, using the question as typed: %s", exc)
        return fallback

    query = raw.get("query")
    types = [t for t in (raw.get("fact_types") or []) if t in intelligence.FACT_TYPES]
    role = raw.get("participant_role")
    return {
        "query": query.strip() if isinstance(query, str) and query.strip() else question,
        "fact_types": types or list(intelligence.FACT_TYPES),
        "participant_role": role if role in intelligence.ROLE_LABEL else None,
        "self_reference": raw.get("self_reference") is True,
    }


def _fmt_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def build_context(sources: list[dict]) -> str:
    """Render the evidence. A fact block carries its structure and its원문 both —
    a structured claim with no original words behind it is never shown."""
    blocks = []
    for i, s in enumerate(sources, 1):
        head = (
            f"[{i}] 회의: {s['meeting_title']} | 시간: {_fmt_time(s['start_time'])}~"
            f"{_fmt_time(s['end_time'])} | 화자: {', '.join(s['speakers']) or '-'}"
        )
        if s.get("kind") != "fact":
            blocks.append(f"{head}\n{s['content']}")
            continue
        meta = [f"{s['fact_label']}: {s['content']}"]
        meta += [f"{label}: {name}" for label, name in s["participants"].items()]
        if s["deadline_text"]:
            at = f" ({s['deadline_at']})" if s["deadline_at"] else ""
            meta.append(f"기한: {s['deadline_text']}{at}")
        meta.append(f"상태: {intelligence.STATUS_LABEL.get(s['status'], s['status'])}")
        blocks.append(
            f"[{i}] 회의: {s['meeting_title']} ({s['meeting_date_label']}) | 시간: "
            f"{_fmt_time(s['start_time'])}~{_fmt_time(s['end_time'])}\n"
            + " / ".join(meta)
            + f"\n원문: {s['source_text']}"
        )
    return "\n\n".join(blocks)


def answer(
    question: str,
    meeting_ids: list[int] | None = None,
    top_k: int = 6,
    history: list[dict] | None = None,
    user_id: int | None = None,
) -> dict:
    """Plan, retrieve both layers, then generate. `history` is oldest first.

    The plan resolves a pronoun follow-up into a standalone search query and says
    which facts are relevant; retrieval then runs twice over the same scope, once
    structured and once dense. Facts come first and in chronological order, so a
    "how did this change" question reads its evidence as a timeline.
    """
    p = plan(question, history)
    speaker_ids = None
    if p["self_reference"]:
        # "내가 요청한 것"은 이 계정이 그 회의에서 누구인지 알아야 답할 수 있다.
        speaker_ids = intelligence.my_speakers(user_id, meeting_ids) if user_id else []
        if not speaker_ids:
            return {"answer": NO_IDENTITY, "sources": []}
    facts = intelligence.search(
        p["query"], meeting_ids, p["fact_types"], p["participant_role"], speaker_ids, top_k
    )
    # A "내가 …" question is answerable only from facts that name this account's
    # speaker. Chunks carry no such filter, so including them here would put
    # somebody else's request in front of a model asked about mine.
    chunks = [] if p["self_reference"] else search(p["query"], meeting_ids, top_k)
    sources = facts + chunks
    if not sources:
        return {"answer": NO_ANSWER, "sources": []}
    if not config.OPENAI_API_KEY:
        return {
            "answer": "OPENAI_API_KEY가 설정되지 않아 답변을 생성할 수 없습니다. "
                      "아래 검색된 근거를 참고하세요.",
            "sources": sources,
        }

    from openai import OpenAI

    try:
        resp = OpenAI(api_key=config.OPENAI_API_KEY).chat.completions.create(
            model=config.OPENAI_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                *(history or []),
                {"role": "user",
                 "content": f"[근거]\n{build_context(sources)}\n\n[질문]\n{question}"},
            ],
        )
    except Exception as exc:
        # retrieval already succeeded - still hand back the evidence
        log.warning("LLM call failed: %s", exc)
        return {
            "answer": f"LLM 답변 생성에 실패했습니다 ({type(exc).__name__}). "
                      "아래 검색된 근거를 참고하세요.",
            "sources": sources,
        }
    return {"answer": resp.choices[0].message.content.strip(), "sources": sources}


def serialize_sources(sources: list[dict]) -> list[dict]:
    """The UI/storage shape, one contract for both layers.

    A fact keeps the transcript words in `text`, the same field a chunk uses, so
    every rendered source is something a reader can check. `deadline_at` is sent
    as a string: this dict is stored as JSONB on the message row.
    """
    out = []
    for i, s in enumerate(sources, 1):
        item = {
            "index": i,
            "kind": s.get("kind", "chunk"),
            "meeting_id": s["meeting_id"],
            "meeting_title": s["meeting_title"],
            "speakers": s["speakers"],
            "start_time": s["start_time"],
            "end_time": s["end_time"],
            "time_label": f"{_fmt_time(s['start_time'])} ~ {_fmt_time(s['end_time'])}",
            "text": s["content"],
            "score": s["score"],
        }
        if s.get("kind") == "fact":
            item.update({
                "fact_id": s["id"],
                "fact_type": s["fact_type"],
                "fact_label": s["fact_label"],
                "summary": s["content"],
                "text": s["source_text"],
                "status": s["status"],
                "deadline_text": s["deadline_text"],
                "deadline_at": s["deadline_at"].isoformat() if s["deadline_at"] else None,
                "participants": s["participants"],
                "meeting_date": s["meeting_date"],
                "meeting_date_label": s["meeting_date_label"],
                "status_label": intelligence.STATUS_LABEL.get(s["status"], s["status"]),
                "source_segment_ids": list(s["source_segment_ids"]),
            })
        else:
            item["chunk_id"] = s["id"]
        out.append(item)
    return out


def is_miss(result: dict) -> bool:
    """Did this answer fail to find anything? Used only to offer a wider search.

    NO_IDENTITY is not a miss: searching the whole corpus would not tell us who
    the asker is either, so offering that would be noise.
    """
    if result["answer"] == NO_IDENTITY:
        return False
    return not result["sources"] or NO_ANSWER in result["answer"]
