"""Whole-meeting OpenAI work: the summary, and STT correction suggestions.

The opposite direction from rag.py. There is no retrieval here — both functions
read the meeting's stored transcript in full and hand it to the model once.

Neither writes to `transcript_segments`. A correction is a suggestion the
reviewer applies in the browser and saves through the existing PATCH, so the
human approval gate keeps its meaning.
"""
import json
import logging

from app import config
from app.db import conn
from app.services import chunking, pipeline

log = logging.getLogger("minutes.assist")

SUMMARY_PROMPT = """당신은 회의록 요약 도우미입니다.
아래 회의록에 실제로 있는 내용만 사용해서 한국어로 요약하세요.

아래 네 항목을 이 순서대로, 이 제목 그대로 작성하세요.

핵심 요약
주요 논의
결정 사항
Action Items

규칙:
- 회의록에 없는 내용을 추측하거나 지어내지 마세요.
- Action Items의 담당자와 기한은 회의에서 명시적으로 언급된 경우에만 적으세요.
  언급되지 않았으면 담당자나 기한을 만들어내지 말고 생략하세요.
- 해당 내용이 없는 항목에는 "없음"이라고만 적으세요.
- 마크다운 기호(#, *, -) 없이 항목 제목과 줄바꿈만 사용하세요."""

CORRECTION_PROMPT = """당신은 음성 인식(STT) 결과를 교정하는 도우미입니다.
회의록 전체 문맥을 참고해서, 명백한 오인식으로 보이는 문장만 골라 고치세요.

규칙:
- STT 오인식, 띄어쓰기, 명백한 용어 오류만 대상으로 합니다.
- 의미를 바꾸지 마세요. 새로운 사실을 추가하지 마세요.
- 확신이 없으면 고치지 말고 그대로 두세요.
- 숫자, 금액, 날짜를 임의로 추정해서 바꾸지 마세요.
- 사람 이름과 회사명도 근거가 없으면 추측하지 마세요.
- 고칠 필요가 없는 문장은 결과에 포함하지 마세요.

입력은 "<번호>: <문장>" 형식입니다.
출력은 아래 JSON 형식만 사용하세요.

{"corrections": [{"sequence": <번호>, "after": "<고친 문장>"}]}

고칠 것이 없으면 {"corrections": []} 를 반환하세요."""


def _complete(system: str, user: str, json_mode: bool = False) -> str:
    if not config.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY가 설정되지 않았습니다.")
    from openai import OpenAI

    resp = OpenAI(api_key=config.OPENAI_API_KEY).chat.completions.create(
        model=config.OPENAI_MODEL,
        temperature=0,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        **({"response_format": {"type": "json_object"}} if json_mode else {}),
    )
    return resp.choices[0].message.content.strip()


def get_summary(meeting_id: int) -> dict | None:
    with conn() as c:
        return c.execute(
            "SELECT content, created_at FROM meeting_summaries WHERE meeting_id = %s",
            (meeting_id,),
        ).fetchone()


def summarize(meeting_id: int) -> dict:
    """Generate and store the meeting summary. Calling it again regenerates.

    # ponytail: the whole transcript goes in one request. A meeting long enough
    # to exceed the model's context would fail outright rather than degrade.
    # Revisit with a map-reduce pass when a real recording actually hits it.
    """
    utterances, names = pipeline.load_transcript(meeting_id)
    if not utterances:
        raise RuntimeError("회의록이 비어 있어 요약할 수 없습니다.")
    content = _complete(SUMMARY_PROMPT, chunking._render(utterances, names))
    with conn() as c:
        return c.execute(
            "INSERT INTO meeting_summaries (meeting_id, content) VALUES (%s,%s)"
            " ON CONFLICT (meeting_id) DO UPDATE"
            "   SET content = EXCLUDED.content, created_at = now()"
            " RETURNING content, created_at",
            (meeting_id, content),
        ).fetchone()


def suggest_corrections(meeting_id: int) -> list[dict]:
    """Propose STT fixes for the meeting's segments. Changes nothing in the database.

    `before` comes from the database rather than from the model, and a suggestion
    whose sequence is unknown or whose text is unchanged is dropped — so a
    hallucinated line cannot reach the reviewer's editor.
    """
    with conn() as c:
        rows = c.execute(
            "SELECT sequence, text FROM transcript_segments WHERE meeting_id = %s"
            " ORDER BY sequence",
            (meeting_id,),
        ).fetchall()
    if not rows:
        return []
    current = {r["sequence"]: r["text"] for r in rows}

    raw = _complete(
        CORRECTION_PROMPT,
        "\n".join(f"{r['sequence']}: {r['text']}" for r in rows),
        json_mode=True,
    )
    try:
        proposed = json.loads(raw).get("corrections", [])
    except (json.JSONDecodeError, AttributeError):
        log.warning("meeting %s: correction response was not usable JSON", meeting_id)
        return []

    out = []
    for item in proposed:
        seq, after = item.get("sequence"), item.get("after")
        if seq not in current or not isinstance(after, str):
            continue
        after = after.strip()
        if not after or after == current[seq]:
            continue
        out.append({"sequence": seq, "before": current[seq], "after": after})
    return out
