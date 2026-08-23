"""Retrieval and answer generation.

Two kinds of evidence reach the model, under one scope rule:

    meeting_facts   structured - who requested, who is assigned, by when
    chunks          the transcript excerpts those facts came out of

The fact layer is additive. Remove it and this is the dense-retrieval RAG it has
always been; a question with no structured answer still gets the excerpts.

Each of those two layers is searched along two axes and the rankings are fused:

    dense     BGE-M3 -> pgvector, cosine.  Finds text that means the same thing.
    lexical   Kiwi -> tsvector, ts_rank_cd. Finds the exact word that was said.

Fusion is Reciprocal Rank Fusion, not a weighted sum of the two scores: a cosine
similarity and a `ts_rank_cd` are not on the same scale, and no constant makes
them comparable. RRF only reads rank positions, which are.
"""
import json
import logging
import re
from collections import defaultdict

from app import config
from app.db import conn
from app.services import access, embedding, fusion, intelligence, lexical

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

# Appended to the evidence, never to the question, and only when the evidence
# actually disagrees with itself. Sits before [질문] so the question stays the
# last thing the model reads.
CONFLICT_NOTE = """
[주의] 위 근거에는 같은 사안에 대해 회의별로 서로 다른 사람이 적혀 있습니다.
하나를 골라 답하지 마세요. 회의별로 나누어 각각 무엇으로 확인되는지 제시하세요."""

# The citation markers the system prompt asks for. Parsed back out so a number
# pointing at evidence that was never sent can be removed.
CITATION = re.compile(r"\[(\d+)\]")

# "내가"를 물었지만 이 계정이 그 회의에서 어느 화자인지 모를 때. 추측하지 않는다.
NO_IDENTITY = (
    "질문하신 분이 회의에서 어느 화자인지 지정되어 있지 않아 확인할 수 없습니다. "
    "회의 상세 화면에서 [나로 지정]을 먼저 눌러 주세요."
)

# 질문한 사람 자신을 가리키는 1인칭 표현. 이 목록에 걸리는 질문만 self-scoped 질의다.
#
# 앞에 한글이 붙어 있으면 다른 단어의 일부다 — "안내 사항"의 "내", "결제 프로세스"의
# "제", "내용"의 "내"는 1인칭이 아니다. 그래서 뒤가 공백인 한 글자 형태("내 담당",
# "제 업무")에도 같은 lookbehind가 붙는다.
SELF_FORMS = (
    "내가", "제가", "나는", "저는", "나도", "저도", "나만", "저만",
    "내게", "제게", "나에게", "저에게", "나한테", "저한테", "내한테",
    "나의", "저의", "내꺼", "제꺼", "내걸", "제걸", "내건", "제건",
)
SELF_REFERENCE = re.compile(
    r"(?<![가-힣])(?:" + "|".join(SELF_FORMS) + r"|[내제](?=\s))"
)


def is_self_scoped(question: str) -> bool:
    """"내가 …"처럼 질문한 사람 자신을 명시적으로 가리키는 질문인가?

    사용자 ↔ 화자 매핑을 요구할지를 여기서만 결정한다. 판정을 LLM에게 맡겼을 때
    "이 통화에서 결정된 내용 정리해줘" 같은 일반 질문이 간헐적으로
    `self_reference: true`로 분류되어 `NO_IDENTITY`로 막혔고, 같은 질문이 다시
    물으면 답변되는 흔들림이 그대로 사용자에게 보였다. 이 함수는 질문 문장만
    보므로 같은 질문은 항상 같은 판정을 받는다.

    # ponytail: 표층 형태 목록. "본인이 맡은 일"처럼 1인칭 표현이 없는 자기 질의는
    # 일반 질의로 처리된다 - 매핑 없이도 검색되고, 화자 필터만 걸리지 않는다.
    # Revisit when a real transcript-era question shows a form worth adding.
    """
    return bool(SELF_REFERENCE.search(question))


PLAN_PROMPT = """당신은 회의록 검색 질문을 분석하는 도우미입니다.
이전 대화와 현재 질문을 보고 아래 JSON만 출력하세요.

{"query": "<검색에 사용할 독립된 질문>",
 "fact_types": ["REQUEST", "DECISION", "ACTION_ITEM"],
 "participant_role": "REQUESTER 또는 ASSIGNEE 또는 DECIDER 또는 null"}

규칙:
- query: 현재 질문의 지시대명사("그 부서", "그 사람", "거기")를 이전 대화에 나온 실제 대상으로
  바꿔서, 그 문장만 읽어도 무엇을 찾는지 알 수 있게 만드세요.
- 이전 대화로 알 수 없으면 현재 질문을 그대로 쓰세요.
- 이전 대화에 없는 사실을 query에 추가하지 마세요. 질문의 의미를 바꾸지 마세요.
- fact_types: 관련 있는 종류만 남기세요. 판단이 어려우면 셋 다 넣으세요.
- participant_role: "누가 요청했어"는 REQUESTER, "누가 맡았어"/"담당이 누구야"는 ASSIGNEE,
  "누가 결정했어"는 DECIDER, 해당 없으면 null."""


# Everything both chunk axes select, so a fused list is one shape regardless of
# which axis found a row. `meeting_at` is here for the metadata layer: a question
# that names a date has to be able to agree with a candidate's meeting.
_CHUNK_COLUMNS = """
    c.id, c.meeting_id, c.version, c.content, c.start_time, c.end_time, c.speaker_codes,
    c.source_segment_ids, m.title AS meeting_title,
    coalesce(m.held_at, m.created_at) AS meeting_at,
    m.held_at IS NOT NULL AS meeting_at_known
"""


def _chunk_rows(rank: str, join: str, where: str, params: dict,
                meeting_ids: list[int] | None, user_id: int | None) -> list[dict]:
    """One chunk query. `rank` is the score expression and the ORDER BY.

    Both axes come through here, which is what makes the scope predicate, the
    access predicate, and the approval predicate literally the same SQL for both.
    An unapproved meeting has no chunks at all, so `m.status` is defence in depth
    rather than the primary gate — it also excludes a meeting whose chunks are
    stale because it went back to review.

    Two independent restrictions, and neither can widen the other:

    `user_id` is who is asking. `access.READABLE` is the same predicate the
    meeting list uses, so retrieval cannot reach a meeting a screen would refuse
    to show. None means no account filter at all and exists only for the
    evaluation harness, which owns its own throwaway schema; every application
    path passes a real account.

    `meeting_ids` is the chat scope: None or empty is everything the account may
    read, and a non-empty list is a hard restriction within that. The caller has
    already intersected it with what the account may read, and this predicate
    holds even if it had not.
    """
    sql = (
        f"SELECT {_CHUNK_COLUMNS}, {rank} AS score"
        f" FROM chunks c JOIN meetings m ON m.id = c.meeting_id{join}"
        f" WHERE m.status = 'COMPLETED' AND {where}"
    )
    if user_id is not None:
        sql += f" AND {access.READABLE}"
        params["auth_uid"] = user_id
    if meeting_ids:
        sql += " AND c.meeting_id = ANY(%(mids)s)"
        params["mids"] = list(meeting_ids)
    sql += f" ORDER BY {rank} DESC LIMIT %(k)s"
    with conn() as c:
        return c.execute(sql, params).fetchall()


def _label_chunks(rows: list[dict]) -> list[dict]:
    """Resolve SPEAKER_00 to the stored display name, per meeting."""
    found = sorted({r["meeting_id"] for r in rows})
    names: dict[tuple[int, str], str] = {}
    if found:
        with conn() as c:
            for s in c.execute(
                "SELECT meeting_id, speaker_code, display_name FROM speakers "
                "WHERE meeting_id = ANY(%s)",
                (found,),
            ).fetchall():
                names[(s["meeting_id"], s["speaker_code"])] = (
                    s["display_name"] or s["speaker_code"]
                )
    for r in rows:
        r["kind"] = "chunk"
        r["speakers"] = [names.get((r["meeting_id"], sc), sc) for sc in r["speaker_codes"]]
        r["score"] = round(float(r["score"]), 6)
    return rows


def search_dense(question: str, meeting_ids: list[int] | None = None,
                 top_k: int = fusion.CANDIDATES, *, user_id: int | None = None) -> list[dict]:
    """Cosine nearest chunks. This is the retrieval this module started with."""
    return _label_chunks(_chunk_rows(
        rank="1 - (c.embedding <=> %(q)s::vector)",
        join="",
        where="c.embedding IS NOT NULL",
        params={"q": embedding.encode_one(question), "k": top_k},
        meeting_ids=meeting_ids,
        user_id=user_id,
    ))


def search_lexical(question: str, meeting_ids: list[int] | None = None,
                   top_k: int = fusion.CANDIDATES, *,
                   user_id: int | None = None) -> list[dict]:
    """Chunks that contain the question's own words, ranked by `ts_rank_cd`.

    A question made only of grammar ("그거 언제까지야?") has no lexemes to search
    for; that is an empty result, not an error, and the dense axis carries it.

    # ponytail: ts_rank_cd has no IDF, so a word in every chunk cannot be
    # down-weighted here and is dropped at index time instead (lexical.STOPWORDS).
    # Revisit with a real BM25 scoring function if measurement shows common-token
    # questions losing precision that stopwords cannot fix.
    """
    tsq = lexical.tsquery(question)
    if not tsq:
        return []
    return _label_chunks(_chunk_rows(
        rank="ts_rank_cd(c.lexeme_tsv, q.query, 32)",
        join=", to_tsquery('simple', %(tsq)s) AS q(query)",
        where="c.lexeme_tsv @@ q.query",
        params={"tsq": tsq, "k": top_k},
        meeting_ids=meeting_ids,
        user_id=user_id,
    ))


def search(question: str, meeting_ids: list[int] | None = None, top_k: int = 6,
           mode: str | None = None, *, user_id: int | None = None) -> list[dict]:
    """Chunk retrieval: both axes, fused, Top-K. The scope is a hard restriction.

    Kept as the single chunk entry point `answer` calls, so there is one place
    where "which excerpts may this question see" is decided — both who is asking
    and which meetings they picked.
    """
    mode = mode or fusion.RETRIEVAL_MODE
    n = fusion.CANDIDATES
    dense = [] if mode == "lexical" else search_dense(question, meeting_ids, n, user_id=user_id)
    lex = [] if mode == "dense" else search_lexical(question, meeting_ids, n, user_id=user_id)
    return fusion.fuse(dense, lex, question, top_k, mode)


def plan(question: str, history: list[dict] | None = None) -> dict:
    """One call that resolves a follow-up and names what to filter facts on.

    Retrieval only. The generator always receives the question exactly as typed —
    a rewrite is a search aid, never a change to what was asked. Any failure at
    all (no key, bad JSON, an unknown enum value) falls back to the plain
    question with no filters, which is the behaviour this module had before.

    `self_reference` is not part of that call. It is computed from the question
    by `is_self_scoped`, so the one decision that can refuse to search at all is
    deterministic and identical on every repeat of the same question.
    """
    fallback = {
        "query": question,
        "fact_types": list(intelligence.FACT_TYPES),
        "participant_role": None,
        "self_reference": is_self_scoped(question),
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
        # Never the model's opinion: a single wrong `true` used to answer a
        # general question with NO_IDENTITY, and the same question then worked on
        # the next attempt.
        "self_reference": is_self_scoped(question),
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


def has_conflict(sources: list[dict]) -> bool:
    """Do two meetings put different people in the same role for the same thing?

    This is computed from the retrieved rows, not asked of the model: the model is
    the thing being kept honest. When it is true the evidence genuinely supports
    two answers, and picking one would be the application inventing a resolution
    the meetings never reached.

    # ponytail: "the same thing" is one shared content lexeme between the two
    # facts. It is deliberately loose — a superseded assignment ("담당을 박서연
    # 님으로 바꾸겠습니다") reads exactly like an unresolved disagreement from
    # here, and the required behaviour is the same for both: show both meetings.
    # Revisit only if a measured false-positive rate makes answers worse.
    """
    by_role: dict[str, list[tuple[int, str, set]]] = defaultdict(list)
    for s in sources:
        if s.get("kind") != "fact":
            continue
        words = set(lexical.tokens(s["content"]))
        for role, name in s["participants"].items():
            by_role[role].append((s["meeting_id"], name, words))
    for entries in by_role.values():
        for i, (mid, name, words) in enumerate(entries):
            for other_mid, other_name, other_words in entries[i + 1:]:
                if mid != other_mid and name != other_name and words & other_words:
                    return True
    return False


def validate_citations(answer: str, count: int) -> str:
    """Drop a [N] that points at evidence the model was never given.

    The model is told to cite the numbered excerpts it used. Those numbers are
    generated by `build_context` from the rows retrieval actually returned, so
    any number outside 1..count is a citation to something that does not exist
    and must not be shown as provenance. The claim's wording is left alone —
    editing prose the model wrote would be a different kind of invention.
    """
    dropped = []

    def keep(match: re.Match) -> str:
        n = int(match.group(1))
        if 1 <= n <= count:
            return match.group(0)
        dropped.append(n)
        return ""

    cleaned = CITATION.sub(keep, answer)
    if not dropped:
        return answer
    log.warning("dropped citation(s) to evidence that was not sent: %s", dropped)
    return re.sub(r" {2,}", " ", cleaned).strip()


def answer(
    question: str,
    meeting_ids: list[int] | None = None,
    top_k: int = 6,
    history: list[dict] | None = None,
    user_id: int | None = None,
    mode: str | None = None,
) -> dict:
    """Plan, retrieve both layers, then generate. `history` is oldest first.

    The plan resolves a pronoun follow-up into a standalone search query and says
    which facts are relevant; retrieval then runs over the same scope twice, once
    structured and once over the excerpts, and each of those fuses its dense and
    lexical rankings. Facts come first and in chronological order, so a "how did
    this change" question reads its evidence as a timeline.

    `user_id` is the account asking. It is the access boundary for every one of
    the four retrieval paths, not only the speaker mapping: `meeting_ids` says
    which meetings were *chosen*, and this says which may be *seen*. None is the
    evaluation harness on its own schema.

    `mode` is the retrieval configuration and exists for the evaluation harness;
    the application never passes it.
    """
    p = plan(question, history)
    speaker_ids = None
    if p["self_reference"]:
        # "내가 요청한 것"은 이 계정이 그 회의에서 누구인지 알아야 답할 수 있다.
        speaker_ids = intelligence.my_speakers(user_id, meeting_ids) if user_id else []
        if not speaker_ids:
            return {"answer": NO_IDENTITY, "sources": []}
    facts = intelligence.search(
        p["query"], meeting_ids, p["fact_types"], p["participant_role"], speaker_ids,
        top_k, mode, user_id=user_id,
    )
    # A "내가 …" question is answerable only from facts that name this account's
    # speaker. Chunks carry no such filter, so including them here would put
    # somebody else's request in front of a model asked about mine.
    chunks = (
        [] if p["self_reference"]
        else search(p["query"], meeting_ids, top_k, mode, user_id=user_id)
    )
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
                 "content": f"[근거]\n{build_context(sources)}"
                            f"{CONFLICT_NOTE if has_conflict(sources) else ''}"
                            f"\n\n[질문]\n{question}"},
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
    generated = resp.choices[0].message.content.strip()
    return {"answer": validate_citations(generated, len(sources)), "sources": sources}


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
            # Which revision of the minutes these words are from. Stored on the
            # message, so an answer given before a correction still says which
            # transcript it rested on.
            "meeting_version": s.get("version"),
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
            # Provenance for an excerpt, the same contract a fact has carried
            # since it existed. NULL on a chunk indexed before migration 007;
            # re-indexing the meeting fills it, and nothing invents it.
            item["source_segment_ids"] = list(s.get("source_segment_ids") or [])
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
