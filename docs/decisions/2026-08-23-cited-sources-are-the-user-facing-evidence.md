# 출처 is what the answer cited, not what the search found

**Date:** 2026-08-23
**Status:** accepted
**Migration:** none
**Amends the presentation half of:**
[2026-08-21-hybrid-retrieval-with-kiwi-and-rrf.md](2026-08-21-hybrid-retrieval-with-kiwi-and-rrf.md)

## Context

Retrieval sends Top-K candidates over two layers to the model. The model answers
from the ones it can use and marks them `[1]`, `[3]`. Everything that came back
from the search was then handed to the browser as `sources`, and the 출처 panel
listed all of it.

The result was a user-facing contract that did not hold. An answer resting on two
excerpts sat under a control reading `검색 결과 6개`, and opening it produced six
cards — two the answer quoted and four it did not, in one list, distinguished
only by a slightly lower opacity and a sentence at the bottom saying how many
were not cited. A reader opening 출처 is doing one thing: checking whether the
sentence they just read is true. Four unquoted search results are not evidence
for that sentence, and putting them in the same list makes the two quoted ones
harder to find rather than easier to trust.

The alternative reading — that the panel is a window onto the search — is a
different feature, and nobody asked for it. It is also the reading that produced
`출처 6개` on an answer with two citations.

## Decision

**Two lists, named for what they are.** `POST /api/chat/sessions/{id}/messages`
and `GET /api/chat/sessions/{id}` both return:

| field | what it is | who reads it |
|---|---|---|
| `sources` | every retrieved candidate, in retrieval order | the model, the stored row, the scope invariant |
| `cited_sources` | the subset the answer marked `[N]` | the 출처 count and the 출처 panel |

`app/services/rag.py:cited_sources` computes the second from the first and the
answer text. It is the only place that decides, it is applied at both response
boundaries, and the browser reads `cited_sources` and nothing else.

**Nothing is dropped.** Retrieval still runs Top-K over both layers, the model
still receives every retrieved source, the response still carries all of them,
and `chat_messages.sources` still stores all of them. The change is which list
the screen renders — and that a reader is no longer shown a search result
labelled as provenance.

**Indices are never renumbered.** The `[3]` the model wrote has to name the card
labelled `[3]`, so the cited subset keeps retrieval's numbering and retrieval's
order. A number cited twice yields one card; a number outside the evidence yields
none and stays plain text in the prose, which is what `validate_citations`
already guaranteed upstream.

**Computed on read, never stored.** `get_session` derives `cited_sources` from
the answer text stored beside the payload, so a conversation reopened tomorrow
shows the same cards — after an alias renames the meeting, and after a revoked
share strips the excerpt.

**The two fallback answers keep their evidence.** When there is no API key, or
the LLM call fails, the application writes the answer itself and it says
"아래 검색된 근거를 참고하세요". Those cite nothing, and for them the retrieved set
*is* the answer, so `cited_sources` returns it whole. They are matched by prefix
(`rag.NO_KEY_ANSWER`, `rag.LLM_FAILED_PREFIX`) so a stored message is recognised
the same way a live one is.

**An answer that quoted nothing has no 출처 control.** Not `출처 0개`, and not a
fallback to the candidate count: no button, because there is nothing to check.

## Alternatives rejected

**Narrow `sources` itself and send one list.** Simpler payload, and wrong. The
retrieved set is what proves the chat scope invariant — that no retrieval path
reached outside the meetings the caller chose — and `tests/test_chat.py`,
`tests/test_ownership.py`, and `tests/test_sharing.py` all observe it through
that field. Removing it would take the evidence for the security property out of
the API to make a screen shorter.

**Lower Top-K to whatever the answer cites.** Not possible even in principle: the
model cannot cite an excerpt it was not given. Retrieval breadth is what makes a
good citation available; the panel is downstream of it.

**Filter in the browser.** The browser would need the citation-parsing rule, and
so would every other client. One rule, on the server, next to the one that
removes invented citations.

## Consequences

- `AGENTS.md` "RAG / provenance invariant" changes on one point: how many sources
  are *shown* is now the number the answer cited, and the panel holds exactly
  those. "Never drop a source" still binds retrieval, the response, and storage —
  which is where it was always about.
- The 출처 panel no longer has an "answer did not cite N of these" footnote,
  because there is nothing in it the answer did not cite.
- A reader who wants to see what else the search found has no screen for it. That
  is deliberate: it is a retrieval-debugging view, and this is not a
  retrieval-debugging product. `python -m scripts.evaluate` is where that
  question is answered.
