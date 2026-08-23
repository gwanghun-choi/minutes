"""Whole-meeting OpenAI work: the summary, and STT post-correction suggestions.

The opposite direction from rag.py. There is no retrieval here — both functions
read the meeting's stored transcript in full and hand it to the model once.

Neither writes to `transcript_segments`. A correction is a suggestion the
reviewer applies in the browser and saves through the existing PATCH, so the
human approval gate keeps its meaning.

Correction is *context-aware transcript post-correction*, not proofreading and
not a second listen: no audio is read here, and nothing in this module may be
described as re-hearing the recording. What it has instead of the audio is the
conversation around each line, which is what lets a mis-heard word be caught at
all — see `_render_for_correction`.
"""
import json
import logging

from app import config
from app.db import conn
from app.services import chunking, pipeline, versions

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

CORRECTION_PROMPT = """당신은 한국어 회의의 음성 인식(STT) 결과를 검토하는 교정 도우미입니다.

입력은 사람이 쓴 글이 아니라 음성에서 받아쓴 결과이며, 단어 자체가 잘못
인식되었을 수 있습니다. 당신의 일은 문장을 다듬는 것이 아니라, 앞뒤 대화를 보고
실제로 무슨 말이었을지 판단해서 명백히 잘못 받아쓴 부분만 되돌리는 것입니다.

입력은 시간순으로 한 줄에 한 발화씩 주어집니다.

<번호> [mm:ss~mm:ss] <화자>: <문장>

판단 규칙:
1. 한 문장은 반드시 바로 앞 발화와 바로 뒤 발화까지 함께 읽고 판단합니다.
   화자가 바뀌는 지점과 상대가 어떻게 대답했는지가 가장 강한 단서입니다.
2. 기존 단어를 무조건 보존하지 마세요. 문법은 멀쩡한데 대화 흐름에서 뜻이 통하지
   않는 단어는 그 단어 자체가 오인식일 가능성이 높습니다.
3. 그렇다고 문법만 자연스러워지는 수정은 하지 마세요. 고친 문장은 앞뒤 발화와
   의미가 이어져야 하고, 상대의 대답과도 맞아야 합니다. 둘 중 하나라도 어긋나면
   고치지 마세요.
4. 문맥에 근거가 없는 단어를 지어내지 마세요. 들리지 않은 정보를 덧붙이지 마세요.
5. 말투를 바꾸지 마세요. 구어체를 문어체로 고치거나 문장을 다시 쓰지 마세요.
6. 이미 뜻이 통하는 문장은 그대로 둡니다. 동의어로 바꾸지 마세요.
7. 고치는 범위는 최소로 합니다. 잘못 인식된 부분만 바꿉니다.
8. 다음은 특히 보수적으로 다룹니다. 문맥에 분명한 근거가 없으면 그대로 두세요.
   사람 이름, 회사명, 제품명, 숫자, 금액, 날짜, 기한, 장소, 전문 용어,
   요청 내용, 결정 내용, 담당자.
9. 부정과 긍정, 가능과 불가능, 조건은 절대로 뒤집지 마세요.
   "안 됩니다"를 "됩니다"로 바꾸는 것 같은 수정은 금지입니다.
10. 확신이 없으면 고치지 말고 그대로 두세요. 제안하지 않는 것이 기본값입니다.
    제안이 많다고 좋은 것이 아니며, 고칠 것이 없으면 없다고 답하는 것이 맞습니다.

수정마다 왜 그렇게 잘못 들렸다고 보는지를 앞뒤 문맥에 근거해 한 문장으로 반드시
적습니다. 근거를 적을 수 없다면 그 수정은 제안하지 마세요.

출력은 아래 JSON 형식만 사용하세요.

{"corrections": [{"sequence": <번호>, "after": "<고친 문장>", "reason": "<근거 한 문장>"}]}

고칠 것이 없으면 {"corrections": []} 를 반환하세요."""

# A suggestion's stated basis, capped. Long enough for one sentence of context
# and short enough to sit under the before/after in the review panel.
REASON_MAX = 200


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
    # The published version. Summarizing is only offered on an approved meeting,
    # and a draft revision open beside it is not what the summary describes.
    utterances, names = pipeline.load_transcript(meeting_id, versions.current(meeting_id))
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


def _render_for_correction(rows: list[dict]) -> str:
    """The transcript as a conversation, one utterance per line, in time order.

    Sequence, clock, and speaker on every line, because a mis-heard *word* can
    only be caught from the turn around it. "혹시 턱 되실까요, 잠깐?" is
    grammatically repairable into "혹시 턱 괜찮으실까요" without ever noticing
    that the previous line is 여보세요 and the next one is a bare 네 — a shape in
    which asking about somebody's jaw is not a thing anyone says. The model
    cannot use that unless it can see who spoke and in what order.

    One request for the whole meeting rather than a window per line: the
    surrounding turns are what matters and they are all here already, and a call
    per segment would multiply an OpenAI request by the length of the recording
    for context this rendering gives away for free.
    """
    # Deferred: `intelligence` imports this module and `rag` imports
    # `intelligence`, so this import cannot sit at the top of the file. Taken
    # once per call, not per line.
    from app.services import rag

    return "\n".join(
        f"{r['sequence']} [{rag._fmt_time(r['start'])}~{rag._fmt_time(r['end'])}]"
        f" {r['display_name']}: {r['text']}"
        for r in rows
    )


def suggest_corrections(meeting_id: int, version: int) -> list[dict]:
    """Propose STT fixes for one draft's segments. Changes nothing in the database.

    `before` comes from the database rather than from the model, and a suggestion
    is dropped unless it names a sequence that exists, actually changes the text,
    and says why. The last one is the abstention gate: the prompt tells the model
    not to propose a change it cannot justify from the surrounding turns, and
    this is where that is enforced rather than trusted — a correction with no
    stated basis is exactly the confident-but-incoherent rewrite this is meant to
    stop. A hallucinated line therefore cannot reach the reviewer's editor.

    Every suggestion that comes back is one the reviewer may apply as-is, which
    is what makes 모두 반영 safe: there is no "uncertain" tier in the response
    because an uncertain suggestion is simply not returned.

    One suggestion per segment. A model that proposes the same line twice gets
    its first answer used; two cards for one sequence would be two 반영 buttons
    writing over each other.

    `version` is the draft being reviewed, and it is required: proposing fixes
    against the published transcript while the reviewer edits a revision would
    hand them corrections for lines that are not on their screen.
    """
    rows, _ = pipeline.load_transcript(meeting_id, version)
    if not rows:
        return []
    current = {r["sequence"]: r["text"] for r in rows}

    raw = _complete(CORRECTION_PROMPT, _render_for_correction(rows), json_mode=True)
    try:
        proposed = json.loads(raw).get("corrections", [])
    except (json.JSONDecodeError, AttributeError):
        log.warning("meeting %s: correction response was not usable JSON", meeting_id)
        return []

    out: list[dict] = []
    seen: set[int] = set()
    for item in proposed if isinstance(proposed, list) else []:
        if not isinstance(item, dict):
            continue
        seq, after, reason = item.get("sequence"), item.get("after"), item.get("reason")
        # `isinstance` before the lookup: a model that answers with a list or an
        # object where the number goes would otherwise raise on an unhashable key.
        if not isinstance(seq, int) or seq in seen or seq not in current:
            continue
        if not isinstance(after, str) or not isinstance(reason, str):
            continue
        after, reason = after.strip(), reason.strip()
        if not after or not reason or after == current[seq]:
            continue
        seen.add(seq)
        out.append({
            "sequence": seq,
            "before": current[seq],
            "after": after,
            "reason": reason[:REASON_MAX],
        })
    return out
