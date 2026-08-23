"""Meeting Intelligence: structured facts over an approved transcript.

`chunks` answer "what was said". These facts answer "who asked whom to do what,
by when, and what was decided" — held in PostgreSQL with pgvector, not a graph
database. Four tables and two joins cover the relationships this product needs;
see `docs/decisions/2026-08-21-meeting-intelligence.md` for when that stops
being true.

Two rules hold the whole module up:

* Nothing is extracted from a draft. The source is always the approved,
  human-reviewed transcript, read through `pipeline.load_transcript`.
* Nothing is stored without provenance. A fact cites the transcript segments it
  came from, and one that cites none is dropped rather than saved.
"""
import datetime as dt
import json
import logging
import re
import traceback

from app import config
from app.db import conn
from app.services import access, assist, embedding, fusion, lexical, pipeline, versions

log = logging.getLogger("minutes.intelligence")

FACT_TYPES = ("REQUEST", "DECISION", "ACTION_ITEM")
# UNKNOWN is the honest default, not OPEN. A meeting that never said whether
# something is finished has not said it is open either, and "아직 안 끝난 것"
# must not silently collect facts nobody gave a status to.
STATUSES = ("UNKNOWN", "OPEN", "DONE", "CANCELLED", "DEFERRED")
STATUS_LABEL = {
    "UNKNOWN": "미확인(회의에서 완료 여부가 언급되지 않음)",
    "OPEN": "진행 중", "DONE": "완료", "CANCELLED": "취소", "DEFERRED": "연기",
}
# OWNER is not a role of its own: the person a task belongs to is its ASSIGNEE.
ROLE_FIELDS = {
    "requester_speaker_id": "REQUESTER",
    "assignee_speaker_id": "ASSIGNEE",
    "decider_speaker_id": "DECIDER",
}
ROLE_LABEL = {"REQUESTER": "요청자", "ASSIGNEE": "담당자", "DECIDER": "결정자"}
TYPE_LABEL = {"REQUEST": "요청", "DECISION": "결정", "ACTION_ITEM": "Action Item"}

# One window is one prompt. ~40 utterances is a few minutes of meeting and sits
# far inside the model's context; the overlap keeps a request and the reply that
# accepts it from landing in different windows.
WINDOW_SEGMENTS = 40
OVERLAP_SEGMENTS = 5

EXTRACT_PROMPT = """당신은 회의록에서 구조화된 사실만 추출하는 도우미입니다.

입력의 각 줄은 다음 형식입니다.
[segment=<발화 id> speaker=<화자 id> name=<화자명> start=<초> end=<초>] <발화 내용>

아래 세 종류만 추출하세요.
- REQUEST: 누군가가 다른 사람에게 무엇을 해달라고 요청한 것
- DECISION: 회의에서 확정된 결정
- ACTION_ITEM: 말한 사람 자신이 앞으로 할 구체적인 행동을 명시적으로 약속하거나
  수락한 것. 다른 사람이 시킨 일이 아니라 **그 발화의 화자가 하겠다고 말한 것**입니다.
  "제가 보내드리겠습니다", "문자로 남겨드리겠습니다", "확인하겠습니다",
  "처리하겠습니다", "내일까지 정리해서 전달하겠습니다", "네, 제가 맡겠습니다"
  같은 표현이 여기에 해당합니다.

REQUEST와 ACTION_ITEM은 서로를 대체하지 않습니다. 한 사람이 요청하고 다른 사람이
수락하면 **두 개를 모두 출력하세요.** 각각의 근거 발화는 서로 다릅니다.

예:
[segment=101 speaker=7 name=화자 B] 현관 비밀번호 있으면 저한테 남겨주시면 감사하겠습니다.
[segment=102 speaker=6 name=화자 A] 아, 네. 통화 종료하고 바로 문자로 남겨드리겠습니다.

→ REQUEST  (segment 101, requester=7)   현관 비밀번호를 남겨 달라는 요청
→ ACTION_ITEM (segment 102, assignee=6) 통화 종료 후 현관 비밀번호를 문자로 전달

ACTION_ITEM으로 만들지 않는 것:
- "네", "네, 알겠습니다" 처럼 무엇을 하겠다는 내용이 없는 단순 동의
- "어제 이미 보내드렸습니다" 처럼 이미 끝난 과거 행동
- "제가 확인해볼 수도 있습니다", "하면 좋겠습니다" 처럼 가능성·희망·불확실한 제안
- 상대방에게 하는 요청만 있고 아무도 수락하지 않은 발화 (그것은 REQUEST 하나뿐입니다)
- 단순한 정보 설명, 일반 원칙

출력은 아래 JSON 형식만 사용하세요.

{"facts": [{"fact_type": "REQUEST",
            "content": "<한 문장 요약>",
            "source_segment_ids": [<근거가 된 segment id>],
            "requester_speaker_id": <화자 id 또는 null>,
            "assignee_speaker_id": <화자 id 또는 null>,
            "decider_speaker_id": <화자 id 또는 null>,
            "deadline_text": "<회의에서 실제로 말한 기한 표현 또는 null>",
            "status": "UNKNOWN"}]}

절대 규칙:
- 회의에서 실제로 말하지 않은 요청, 결정, 업무를 만들지 마세요.
- 요청자, 담당자, 결정자를 추측하지 마세요. 명시되지 않았으면 null로 두세요.
- ACTION_ITEM의 assignee_speaker_id는 그 약속을 말한 발화의 speaker id입니다.
- REQUEST의 assignee_speaker_id는 수락한 사람이 요청 발화 안에서 지목된 경우에만
  적으세요. 다른 발화에서 수락했다는 이유로 요청에 담당자를 붙이지 마세요.
- source_segment_ids에는 그 사실의 근거가 실제로 들어 있는 발화만 넣으세요.
- 입력에 없는 화자 id를 쓰지 마세요.
- 기한을 추측하지 마세요. 실제로 말한 표현만 deadline_text에 그대로 넣으세요.
- 날짜를 계산하거나 만들어내지 마세요.
- 숫자와 금액을 바꾸지 마세요.
- source_segment_ids가 비어 있는 항목은 출력하지 마세요.
- status는 회의에서 명시된 경우에만 DONE(완료) / CANCELLED(취소) / DEFERRED(연기) /
  OPEN(아직 진행 중이라고 말한 경우)으로 하세요.
- 하겠다고 약속한 것만으로는 상태가 정해지지 않습니다. 그것은 UNKNOWN입니다.
- 상태를 알 수 없거나 언급되지 않았으면 반드시 UNKNOWN으로 두세요. 추측하지 마세요.
- 추출할 것이 없으면 {"facts": []} 를 반환하세요."""


def _complete(system: str, user: str) -> str:
    """The same single OpenAI entry point assist.py uses. Always JSON mode."""
    return assist._complete(system, user, json_mode=True)


# ------------------------------------------------------------------ deadlines

WEEKDAYS = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}


def _date(year: int, month: int, day: int) -> dt.date | None:
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def deadline_date(text: str | None, base: dt.date) -> dt.date | None:
    """Resolve a spoken deadline against the meeting's date, or return None.

    `base` is when the meeting was *held*. The model never produces a date — it
    repeats the words that were said, and this turns them into one only when the
    year, month, and day are all pinned. Anything else keeps `deadline_text` and
    leaves `deadline_at` empty: an invented deadline is worse than a missing one.

    A bare "8월 10일" is deliberately not resolved. It states no year, and both
    candidate years are guesses — rolling a past date forward to next year in
    particular invents a deadline a year away from anything that was said.

    # ponytail: the Korean forms that actually appear in these meetings, matched
    # with `re` and `timedelta`. "이달 말", "다음 달 5일", quarter and fiscal
    # expressions all fall through to None. Revisit when a real transcript shows
    # a form worth adding - not before.
    """
    if not text:
        return None
    t = text.strip()
    # Relative to the day the meeting was held: one reading, no year to guess.
    for word, delta in (("모레", 2), ("내일", 1), ("오늘", 0)):
        if word in t:
            return base + dt.timedelta(days=delta)
    if m := re.search(r"(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})", t):
        return _date(*(int(g) for g in m.groups()))
    if m := re.search(r"([월화수목금토일])\s*요일", t):
        # "금요일까지" is the next Friday, and on a Friday it is the following
        # one; "다음 주 금요일" adds a week to that.
        ahead = (WEEKDAYS[m.group(1)] - base.weekday()) % 7 or 7
        return base + dt.timedelta(days=ahead + (7 if "다음" in t or "차주" in t else 0))
    return None


# ----------------------------------------------------------------- extraction


def _windows(utterances: list[dict]) -> list[list[dict]]:
    step = max(1, WINDOW_SEGMENTS - OVERLAP_SEGMENTS)
    out = []
    for i in range(0, len(utterances), step):
        out.append(utterances[i:i + WINDOW_SEGMENTS])
        if i + WINDOW_SEGMENTS >= len(utterances):
            break
    return out


def _render(window: list[dict]) -> str:
    """Every line carries its own provenance, so the model cannot invent an id."""
    return "\n".join(
        f"[segment={u['id']} speaker={u['speaker_id']} name={u['display_name']}"
        f" start={u['start']:.1f} end={u['end']:.1f}] {u['text']}"
        for u in window
    )


def _validate(raw: list, by_id: dict, speaker_ids: set, meeting_date: dt.date) -> list[dict]:
    """Keep only what the transcript actually supports.

    A segment id this meeting does not have is dropped; a fact left without any
    source is dropped with it. A speaker id that is not this meeting's speaker
    loses the role rather than the fact — the fact was still said.
    """
    out = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        content = content.strip() if isinstance(content, str) else ""
        if item.get("fact_type") not in FACT_TYPES or not content:
            continue
        ids = sorted({
            i for i in (item.get("source_segment_ids") or [])
            if isinstance(i, int) and i in by_id
        })
        if not ids:
            continue
        segments = [by_id[i] for i in ids]
        participants = {}
        for field, role in ROLE_FIELDS.items():
            sid = item.get(field)
            if isinstance(sid, int) and sid in speaker_ids:
                participants[role] = sid
        deadline_text = item.get("deadline_text")
        deadline_text = (
            deadline_text.strip()
            if isinstance(deadline_text, str) and deadline_text.strip()
            else None
        )
        out.append({
            "fact_type": item["fact_type"],
            "content": content,
            "status": item.get("status") if item.get("status") in STATUSES else "UNKNOWN",
            "deadline_text": deadline_text,
            "deadline_at": deadline_date(deadline_text, meeting_date),
            "start_time": segments[0]["start"],
            "end_time": segments[-1]["end"],
            "source_segment_ids": ids,
            "source_text": "\n".join(f"{s['display_name']}: {s['text']}" for s in segments),
            "participants": participants,
        })
    return out


def _dedupe(facts: list[dict]) -> list[dict]:
    """Overlapping windows see the same utterances twice. Same type and same
    sources, or same type and same wording, is the same fact."""
    seen: set = set()
    out = []
    for f in facts:
        keys = {
            (f["fact_type"], tuple(f["source_segment_ids"])),
            (f["fact_type"], f["content"]),
        }
        if keys & seen:
            continue
        seen |= keys
        out.append(f)
    return out


def canonical(fact: dict, names: dict) -> str:
    """The text that gets embedded.

    The labels belong in it: "기한 언제야?" has to land near a fact that carries
    one, and the fact's own wording rarely contains the word 기한.
    """
    parts = [f"[{TYPE_LABEL[fact['fact_type']]}] {fact['content']}"]
    parts += [
        f"{ROLE_LABEL[role]}: {names.get(sid, '')}"
        for role, sid in sorted(fact["participants"].items())
    ]
    if fact["deadline_text"]:
        parts.append(f"기한: {fact['deadline_text']}")
    return " / ".join(parts)


def build(meeting_id: int) -> int:
    """Extract, validate, embed, and replace this meeting's facts. -> fact count.

    Everything is extracted and embedded *before* a single row is deleted, and
    the delete and the inserts share one transaction. A failed extraction
    therefore leaves the facts that were already there exactly as they were.
    """
    # The published version, always. A draft revision is not a source: it has not
    # been approved, and the facts extracted from it would answer questions about
    # minutes nobody has agreed to yet.
    version = versions.current(meeting_id)
    utterances, _ = pipeline.load_transcript(meeting_id, version)
    if not utterances:
        raise RuntimeError("회의록이 비어 있어 정보를 추출할 수 없습니다.")
    with conn() as c:
        meeting = c.execute(
            # held_at is when the meeting happened; created_at is only when it was
            # uploaded. A relative deadline was spoken on the day of the meeting,
            # so that is what it resolves against - the fallback is a last resort.
            "SELECT coalesce(held_at, created_at) AS occurred_at FROM meetings"
            " WHERE id = %s",
            (meeting_id,),
        ).fetchone()
    meeting_date = meeting["occurred_at"].date()
    by_id = {u["id"]: u for u in utterances}
    speaker_ids = {u["speaker_id"] for u in utterances if u["speaker_id"]}
    names = {u["speaker_id"]: u["display_name"] for u in utterances if u["speaker_id"]}

    facts: list[dict] = []
    for window in _windows(utterances):
        raw = _complete(EXTRACT_PROMPT, _render(window))
        try:
            parsed = json.loads(raw).get("facts", [])
        except (json.JSONDecodeError, AttributeError, TypeError):
            log.warning("meeting %s: extraction response was not usable JSON", meeting_id)
            continue
        facts.extend(_validate(parsed, by_id, speaker_ids, meeting_date))
    return store(meeting_id, _dedupe(facts), names, version)


def store(meeting_id: int, facts: list[dict], names: dict, version: int | None = None) -> int:
    """Replace this meeting's facts with `facts`, in one transaction. -> count.

    Split out of `build` because the evaluation harness needs the same rows
    without an LLM in the loop (see scripts/evaluate.py): a fixture whose facts
    are inserted by a second code path would be measuring that second path.

    `version` is the revision these facts were extracted from, and it is stored
    on every row so a returned fact can say which minutes it came from. None
    resolves to the meeting's current version.

    Both indexes are written together, exactly as `pipeline.index_transcript`
    writes a chunk's: `canonical` for the vector and for the labels a question
    like "기한 언제야?" needs, `source_text` for the words that were actually
    said, so a lexical search for a name or a number can find the fact carrying
    it and not only the summary of it.
    """
    vectors = embedding.encode([canonical(f, names) for f in facts]) if facts else []
    with conn() as c:
        if version is None:
            version = versions.current(meeting_id, c)
        c.execute("DELETE FROM meeting_facts WHERE meeting_id = %s", (meeting_id,))
        for fact, vec in zip(facts, vectors):
            fact_id = c.execute(
                "INSERT INTO meeting_facts (meeting_id, version, fact_type, content, status,"
                " deadline_text, deadline_at, start_time, end_time, source_segment_ids,"
                " source_text, lexemes, embedding)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                " RETURNING id",
                (meeting_id, version, fact["fact_type"], fact["content"], fact["status"],
                 fact["deadline_text"], fact["deadline_at"], fact["start_time"],
                 fact["end_time"], fact["source_segment_ids"], fact["source_text"],
                 lexical.lexemes(f"{canonical(fact, names)}\n{fact['source_text']}"), vec),
            ).fetchone()["id"]
            for role, speaker_id in fact["participants"].items():
                c.execute(
                    "INSERT INTO meeting_fact_participants (fact_id, speaker_id, role)"
                    " VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (fact_id, speaker_id, role),
                )
        c.execute(
            "UPDATE meetings SET intelligence_state = 'READY', intelligence_error = NULL"
            " WHERE id = %s",
            (meeting_id,),
        )
    return len(facts)


def claim(meeting_id: int) -> bool:
    """Move an approved meeting into BUILDING, or refuse.

    The same compare-and-set the indexing path uses: only one UPDATE can match,
    so a second request while a build is running is a no-op rather than a
    duplicate run. Only COMPLETED meetings qualify — a draft is not a source.
    """
    with conn() as c:
        return bool(c.execute(
            "UPDATE meetings SET intelligence_state = 'BUILDING', intelligence_error = NULL"
            " WHERE id = %s AND status = 'COMPLETED' AND intelligence_state <> 'BUILDING'"
            " RETURNING id",
            (meeting_id,),
        ).fetchone())


def run_build(meeting_id: int) -> None:
    """Background entry point. Never raises: a failure is a state, not a crash."""
    try:
        build(meeting_id)
    except Exception as exc:
        log.error("meeting %s intelligence failed: %s", meeting_id, traceback.format_exc())
        with conn() as c:
            c.execute(
                "UPDATE meetings SET intelligence_state = 'FAILED', intelligence_error = %s"
                " WHERE id = %s",
                (f"{type(exc).__name__}: {exc}"[:1000], meeting_id),
            )


def after_approval(meeting_id: int) -> None:
    """Second background task after an approval, never part of the approval.

    `claim` only matches a meeting that reached COMPLETED, so a failed indexing
    run silently skips this. Without an API key intelligence is simply not
    configured — that is NOT_BUILT, not a failure.
    """
    if config.OPENAI_API_KEY and claim(meeting_id):
        run_build(meeting_id)


# ------------------------------------------------------------------ retrieval


def my_speakers(user_id: int, meeting_ids: list[int] | None = None) -> list[int]:
    """Which diarized speakers this account is, within the scope. May be empty."""
    sql = "SELECT speaker_id FROM meeting_user_speakers WHERE user_id = %s"
    params: list = [user_id]
    if meeting_ids:
        sql += " AND meeting_id = ANY(%s)"
        params.append(list(meeting_ids))
    with conn() as c:
        return [r["speaker_id"] for r in c.execute(sql, params).fetchall()]


_FACT_COLUMNS = """
    f.id, f.meeting_id, f.version, f.fact_type, f.content, f.status,
    f.deadline_text, f.deadline_at, f.start_time, f.end_time,
    f.source_segment_ids, f.source_text,
    m.title AS meeting_title,
    coalesce(m.held_at, m.created_at) AS meeting_at,
    m.held_at IS NOT NULL AS meeting_at_known
"""


def _fact_rows(rank: str, join: str, where: str, params: dict,
               meeting_ids: list[int] | None, fact_types: list[str] | None,
               role: str | None, speaker_ids: list[int] | None,
               user_id: int | None) -> list[dict]:
    """One fact query, under exactly the scope rules `rag._chunk_rows` obeys.

    `user_id` is who is asking, and it pastes the same `access.READABLE` the
    chunk paths and the meeting list use — so the structured layer cannot become
    a way around a permission the excerpt layer enforces. None is the evaluation
    harness on its own schema; every application path passes a real account.

    `meeting_ids` empty or None is the whole corpus and a non-empty list is a hard
    restriction; nothing here ever widens it. Both axes come through this one
    function, so the access rule, the scope, the approval status, and the
    relationship filters are literally the same SQL for dense and lexical
    retrieval.

    The relationship filtering is the database's job. The model is never handed
    the table and asked to work out who requested what.
    """
    sql = (
        f"SELECT {_FACT_COLUMNS}, {rank} AS score"
        f" FROM meeting_facts f JOIN meetings m ON m.id = f.meeting_id{join}"
        f" WHERE m.status = 'COMPLETED' AND {where}"
    )
    if user_id is not None:
        sql += f" AND {access.READABLE}"
        params["auth_uid"] = user_id
    if meeting_ids:
        sql += " AND f.meeting_id = ANY(%(mids)s)"
        params["mids"] = list(meeting_ids)
    if fact_types:
        sql += " AND f.fact_type = ANY(%(types)s)"
        params["types"] = list(fact_types)
    if role or speaker_ids is not None:
        sql += " AND EXISTS (SELECT 1 FROM meeting_fact_participants p WHERE p.fact_id = f.id"
        if role:
            sql += " AND p.role = %(role)s"
            params["role"] = role
        if speaker_ids is not None:
            sql += " AND p.speaker_id = ANY(%(sids)s)"
            params["sids"] = list(speaker_ids)
        sql += ")"
    sql += f" ORDER BY {rank} DESC LIMIT %(k)s"
    with conn() as c:
        return c.execute(sql, params).fetchall()


def _label_facts(rows: list[dict]) -> list[dict]:
    """Attach participants, labels, and the meeting's date. Mutates in place.

    Runs before fusion, not after: the metadata signal compares a candidate's own
    speakers against the question, so those names have to exist by then.
    """
    if not rows:
        return rows
    with conn() as c:
        parts = c.execute(
            "SELECT p.fact_id, p.role, s.display_name, s.speaker_code"
            " FROM meeting_fact_participants p JOIN speakers s ON s.id = p.speaker_id"
            " WHERE p.fact_id = ANY(%s)",
            (sorted({r["id"] for r in rows}),),
        ).fetchall()
    by_fact: dict[int, dict] = {}
    for p in parts:
        by_fact.setdefault(p["fact_id"], {})[ROLE_LABEL[p["role"]]] = (
            p["display_name"] or p["speaker_code"]
        )
    for r in rows:
        r["kind"] = "fact"
        r["fact_label"] = TYPE_LABEL[r["fact_type"]]
        r["participants"] = by_fact.get(r["id"], {})
        r["speakers"] = list(r["participants"].values())
        r["meeting_date"] = r["meeting_at"].date().isoformat()
        # A date the operator never entered is a registration date. It orders the
        # evidence, but nothing may present it as when the meeting took place.
        r["meeting_date_label"] = (
            r["meeting_date"] if r["meeting_at_known"] else f"{r['meeting_date']} 등록"
        )
        r["score"] = round(float(r["score"]), 6)
    return rows


def search_dense(query: str, meeting_ids=None, fact_types=None, role=None,
                 speaker_ids=None, top_k: int = fusion.CANDIDATES, *,
                 user_id: int | None = None) -> list[dict]:
    """Cosine nearest facts. The embedded text is `canonical`, labels included."""
    return _fact_rows(
        rank="1 - (f.embedding <=> %(q)s::vector)",
        join="",
        where="f.embedding IS NOT NULL",
        params={"q": embedding.encode_one(query), "k": top_k},
        meeting_ids=meeting_ids, fact_types=fact_types,
        role=role, speaker_ids=speaker_ids, user_id=user_id,
    )


def search_lexical(query: str, meeting_ids=None, fact_types=None, role=None,
                   speaker_ids=None, top_k: int = fusion.CANDIDATES, *,
                   user_id: int | None = None) -> list[dict]:
    """Facts whose own words, or the words they came from, match the question."""
    tsq = lexical.tsquery(query)
    if not tsq:
        return []
    return _fact_rows(
        rank="ts_rank_cd(f.lexeme_tsv, q.query, 32)",
        join=", to_tsquery('simple', %(tsq)s) AS q(query)",
        where="f.lexeme_tsv @@ q.query",
        params={"tsq": tsq, "k": top_k},
        meeting_ids=meeting_ids, fact_types=fact_types,
        role=role, speaker_ids=speaker_ids, user_id=user_id,
    )


def search(
    query: str,
    meeting_ids: list[int] | None = None,
    fact_types: list[str] | None = None,
    role: str | None = None,
    speaker_ids: list[int] | None = None,
    top_k: int = 6,
    mode: str | None = None,
    *,
    user_id: int | None = None,
) -> list[dict]:
    """Structured retrieval: both axes, fused, then chronological.

    The chronological sort is the last step and is deliberate. Retrieval decides
    *which* facts; "결정이 어떻게 바뀌었어?" is only answerable if the ones chosen
    then reach the model in the order they happened. held_at first, so the order
    is when the meetings happened, not when they were uploaded.
    """
    mode = mode or fusion.RETRIEVAL_MODE
    n = fusion.CANDIDATES
    args = (meeting_ids, fact_types, role, speaker_ids, n)
    dense = [] if mode == "lexical" else search_dense(query, *args, user_id=user_id)
    lex = [] if mode == "dense" else search_lexical(query, *args, user_id=user_id)
    _label_facts(dense + lex)
    rows = fusion.fuse(dense, lex, query, top_k, mode)
    rows.sort(key=lambda r: (r["meeting_at"], r["start_time"]))
    return rows
