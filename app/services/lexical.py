"""Korean lexical retrieval: Kiwi morphemes, then PostgreSQL full-text search.

Dense retrieval finds text that *means* the same thing. It is weakest exactly
where a meeting is most specific: a product name, an acronym, a person's name, a
number. "SSL 인증서" and "TLS 설정" sit close in embedding space and are not the
same thing, and BGE-M3 has no reason to rank a chunk containing the literal
string "350만원" above one that merely talks about budget.

So this module produces the other axis. Korean is agglutinative, so a raw
`to_tsvector` over the transcript would index "인증서를" and "인증서가" as two
different words and match neither against "인증서". Kiwi cuts the 조사 and 어미
off and leaves the searchable stems:

    최광훈 대리가 SSL 인증서를 발급하기로 했습니다.
    -> 최광훈 대리 ssl 인증서 발급

That string is stored beside the row and indexed by PostgreSQL as a `tsvector`
(see migration 007). Nothing here rewrites the transcript: `lexemes` output is an
index, never something a reader or the model is shown.
"""
import re
from functools import lru_cache

# Which morpheme tags survive. Nouns, foreign words, numbers, Hanja, and verb and
# adjective *stems* — the parts a person would actually type into a search box.
# Everything dropped is grammar: 조사 (JKS/JKO/JX/...), 어미 (EF/EC/EP/ETN),
# 접미사 (XSV/XSA), 보조용언 (VX), and punctuation (SF/SP/SS).
KEEP_TAGS = frozenset({
    "NNG",  # 일반명사    인증서, 예산, 배포
    "NNP",  # 고유명사    최광훈, 서울
    "NNB",  # 의존명사    월, 일, 원, 시간  — units carry date and amount queries
    "NR",   # 수사        만, 천
    "SL",   # 외국어      SSL, PostgreSQL, API
    "SN",   # 숫자        350, 8, 19
    "SH",   # 한자
    "VV",   # 동사 어간    남기(다), 마치(다), 발급하 -> 발급
    "VA",   # 형용사 어간
    "XR",   # 어근
})

# Tokens that pass the tag filter and still carry no search signal. Kept
# deliberately short: PostgreSQL's `ts_rank_cd` has no IDF, so a token that
# appears in every chunk cannot be down-weighted at query time and has to be
# dropped at index time instead.
STOPWORDS = frozenset({
    "것", "수", "등", "때", "데", "줄", "바", "뿐", "거", "게", "적",
    "저", "제", "나", "너", "우리", "여기", "거기", "이거", "그거",
    "있", "없", "같", "되", "하", "말", "보", "주", "가", "오", "이", "그",
})
# Measured and rejected: adding the corpus-wide fillers 회의 / 미팅 / 얘기 / 내용
# to the set above. They have no IDF value in a meeting corpus, which is a good
# argument and the wrong conclusion — it cost hit@3 0.024 and MRR 0.002 on the
# evaluation set and gained nothing, because fusion.TITLE_MATCH already stops a
# single shared title word from being read as naming a meeting.

# tsquery is a small language: `&`, `|`, `!`, `(`, `)`, and `:` are operators.
# Only these characters ever reach it, so a morpheme can never be an operator.
_SAFE = re.compile(r"[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ㐀-䶿一-鿿]")


@lru_cache(maxsize=1)
def _kiwi():
    """One analyzer for the process. Building it loads a model from disk (~0.3s),
    which is far too expensive to repeat per request."""
    from kiwipiepy import Kiwi

    return Kiwi()


def tokens(text: str) -> list[str]:
    """Searchable morphemes, in order, lowercased. Duplicates are kept.

    Position matters to `ts_rank_cd`, and a word said three times in a chunk is
    genuinely more about that word, so this is not a set.
    """
    if not text or not text.strip():
        return []
    out = []
    for t in _kiwi().tokenize(text):
        if t.tag not in KEEP_TAGS:
            continue
        form = _SAFE.sub("", t.form.lower())
        if form and form not in STOPWORDS:
            out.append(form)
    return out


def lexemes(text: str) -> str:
    """The indexable string stored alongside a chunk or a fact."""
    return " ".join(tokens(text))


def tsquery(text: str) -> str | None:
    """An OR query over the question's own morphemes, or None if it has none.

    OR, not AND: a chunk that carries three of the five words a question used is
    a candidate worth ranking, and requiring all of them would answer nothing.
    Selectivity comes from `ts_rank_cd` and then from fusion, not from the
    predicate. None means there is nothing lexical to search for — a question
    made only of grammar — and the caller must fall back to dense retrieval
    rather than send an empty query.
    """
    uniq = list(dict.fromkeys(tokens(text)))
    return " | ".join(uniq) or None
