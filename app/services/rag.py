"""Dense retrieval over minutes.chunks + OpenAI answer generation."""
import logging

from app import config
from app.db import conn
from app.services import embedding

log = logging.getLogger("minutes.rag")

SYSTEM_PROMPT = """당신은 회의록 검색 도우미입니다.
아래 [근거]에 주어진 회의록 발췌만 사용해서 한국어로 답하세요.

규칙:
- [근거]에 없는 내용은 절대 추측하거나 지어내지 마세요.
- [근거]로 답할 수 없으면 "회의록에서 해당 내용을 찾지 못했습니다."라고만 답하세요.
- 답변에는 근거로 사용한 발췌의 번호를 [1], [2] 형식으로 표시하세요.
- 간결하게, 핵심부터 답하세요."""


def search(question: str, meeting_id: int | None = None, top_k: int = 6) -> list[dict]:
    """Dense Top-K over approved meetings only.

    An unapproved meeting has no chunks at all, so the status predicate below is
    defence in depth rather than the primary gate — it also excludes a meeting
    whose chunks are stale because it went back to review.
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
    if meeting_id is not None:
        sql += " AND c.meeting_id = %(mid)s"
        params["mid"] = meeting_id
    sql += " ORDER BY c.embedding <=> %(q)s::vector LIMIT %(k)s"

    with conn() as c:
        rows = c.execute(sql, params).fetchall()

    # map SPEAKER_00 -> stored display name, per meeting
    meeting_ids = sorted({r["meeting_id"] for r in rows})
    names: dict[tuple[int, str], str] = {}
    if meeting_ids:
        with conn() as c:
            for s in c.execute(
                "SELECT meeting_id, speaker_code, display_name FROM speakers "
                "WHERE meeting_id = ANY(%s)",
                (meeting_ids,),
            ).fetchall():
                names[(s["meeting_id"], s["speaker_code"])] = s["display_name"] or s["speaker_code"]

    for r in rows:
        r["speakers"] = [names.get((r["meeting_id"], sc), sc) for sc in r["speaker_codes"]]
        r["score"] = round(float(r["score"]), 4)
    return rows


def _fmt_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def build_context(sources: list[dict]) -> str:
    blocks = []
    for i, s in enumerate(sources, 1):
        blocks.append(
            f"[{i}] 회의: {s['meeting_title']} | 시간: {_fmt_time(s['start_time'])}~"
            f"{_fmt_time(s['end_time'])} | 화자: {', '.join(s['speakers'])}\n{s['content']}"
        )
    return "\n\n".join(blocks)


def answer(question: str, meeting_id: int | None = None, top_k: int = 6) -> dict:
    sources = search(question, meeting_id, top_k)
    if not sources:
        return {"answer": "회의록에서 해당 내용을 찾지 못했습니다.", "sources": []}
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
    return [
        {
            "index": i,
            "chunk_id": s["id"],
            "meeting_id": s["meeting_id"],
            "meeting_title": s["meeting_title"],
            "speakers": s["speakers"],
            "start_time": s["start_time"],
            "end_time": s["end_time"],
            "time_label": f"{_fmt_time(s['start_time'])} ~ {_fmt_time(s['end_time'])}",
            "text": s["content"],
            "score": s["score"],
        }
        for i, s in enumerate(sources, 1)
    ]
