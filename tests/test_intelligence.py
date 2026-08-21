"""Meeting Intelligence: extraction, identity grounding, and structured retrieval.

The rules that matter here are about what may NOT be stored or answered. A fact
with no transcript segment behind it, a participant the model invented, a
deadline nobody said, "내가 요청한 것" for an account that is not mapped to a
speaker — every one of them has to end in nothing, not in a plausible guess.
"""
import datetime as dt
import json

import pytest
from conftest import requires_db

from app.db import conn
from app.services import intelligence, pipeline

pytestmark = requires_db


def parts(meeting_id):
    """(segment ids in order, {display_name: speaker_id}) for a stored transcript."""
    utterances, _ = pipeline.load_transcript(meeting_id)
    return (
        [u["id"] for u in utterances],
        {u["display_name"]: u["speaker_id"] for u in utterances},
    )


def facts_of(meeting_id):
    with conn() as c:
        return c.execute(
            "SELECT * FROM meeting_facts WHERE meeting_id = %s ORDER BY id", (meeting_id,)
        ).fetchall()


def roles_of(fact_id):
    with conn() as c:
        return {
            r["role"]: r["speaker_id"]
            for r in c.execute(
                "SELECT role, speaker_id FROM meeting_fact_participants WHERE fact_id = %s",
                (fact_id,),
            ).fetchall()
        }


def reply(**fact):
    return json.dumps({"facts": [fact]})


REQUEST_MEETING = [
    ("SPEAKER_00", "박 대리님, 금요일까지 API 문서 정리해주세요."),
    ("SPEAKER_01", "네, 제가 맡겠습니다."),
]


# ------------------------------------------------------- extraction contract


def test_a_draft_meeting_is_never_a_source(make_meeting, client, fake_extract):
    mid = make_meeting("초안 회의", REQUEST_MEETING, status="REVIEW_REQUIRED")
    res = client.post(f"/api/meetings/{mid}/intelligence/rebuild")
    assert res.status_code == 409
    assert fake_extract["prompts"] == []  # the model was not even called
    assert facts_of(mid) == []


def test_a_fact_carries_its_participants_and_the_segments_it_came_from(
    make_meeting, fake_extract
):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, spk = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="박 대리가 API 문서를 정리한다",
        source_segment_ids=[seg[0], seg[1]],
        requester_speaker_id=spk["화자 A"], assignee_speaker_id=spk["화자 B"],
        deadline_text="금요일", status="OPEN",
    )
    assert intelligence.build(mid) == 1

    fact = facts_of(mid)[0]
    assert fact["fact_type"] == "REQUEST"
    assert list(fact["source_segment_ids"]) == [seg[0], seg[1]]
    assert "API 문서 정리해주세요" in fact["source_text"]
    assert fact["start_time"] == 0.0 and fact["end_time"] == 9.0
    assert roles_of(fact["id"]) == {
        "REQUESTER": spk["화자 A"], "ASSIGNEE": spk["화자 B"],
    }
    with conn() as c:
        assert c.execute(
            "SELECT intelligence_state s FROM meetings WHERE id = %s", (mid,)
        ).fetchone()["s"] == "READY"


def test_a_fact_with_no_real_source_segment_is_not_stored(make_meeting, fake_extract):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="회의에서 나오지 않은 요청",
        source_segment_ids=[99999999],
    )
    assert intelligence.build(mid) == 0
    assert facts_of(mid) == []


def test_an_invented_segment_id_is_dropped_but_the_real_ones_survive(
    make_meeting, fake_extract
):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="DECISION", content="API 문서를 정리하기로 함",
        source_segment_ids=[seg[0], 99999999],
    )
    intelligence.build(mid)
    assert list(facts_of(mid)[0]["source_segment_ids"]) == [seg[0]]


def test_a_speaker_from_another_meeting_loses_the_role_not_the_fact(
    make_meeting, fake_extract
):
    """The fact was still said. Only the participant claim is unsupported."""
    mid = make_meeting("API 회의", REQUEST_MEETING)
    other = make_meeting("다른 회의", [("SPEAKER_00", "관계없는 이야기입니다.")])
    seg, _ = parts(mid)
    _, other_spk = parts(other)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="API 문서를 정리한다",
        source_segment_ids=[seg[0]],
        assignee_speaker_id=other_spk["화자 A"],
    )
    intelligence.build(mid)
    assert roles_of(facts_of(mid)[0]["id"]) == {}


def test_an_unknown_fact_type_is_refused(make_meeting, fake_extract):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="RISK", content="무언가", source_segment_ids=[seg[0]]
    )
    assert intelligence.build(mid) == 0


def test_a_status_the_meeting_did_not_state_is_unknown_not_open(make_meeting, fake_extract):
    """OPEN is a claim: somebody said this is still outstanding. UNKNOWN is the
    absence of one. Collapsing the two makes "아직 안 끝난 것" count facts nobody
    ever gave a status to."""
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="ACTION_ITEM", content="문서 정리", source_segment_ids=[seg[0]],
        status="아마도 완료",
    )
    intelligence.build(mid)
    assert facts_of(mid)[0]["status"] == "UNKNOWN"


def test_a_fact_with_no_status_at_all_is_unknown(make_meeting, fake_extract):
    """Including a REQUEST or a DECISION: neither gets a default of OPEN."""
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["replies"] = [
        json.dumps({"facts": [
            {"fact_type": "REQUEST", "content": "API 문서 정리",
             "source_segment_ids": [seg[0]]},
            {"fact_type": "DECISION", "content": "금요일 마감으로 한다",
             "source_segment_ids": [seg[1]]},
        ]})
    ]
    intelligence.build(mid)
    assert [f["status"] for f in facts_of(mid)] == ["UNKNOWN", "UNKNOWN"]


@pytest.mark.parametrize("stated,stored", [("DONE", "DONE"), ("CANCELLED", "CANCELLED"),
                                           ("DEFERRED", "DEFERRED"), ("OPEN", "OPEN")])
def test_an_explicitly_stated_status_is_kept(make_meeting, fake_extract, stated, stored):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="ACTION_ITEM", content="문서 정리", source_segment_ids=[seg[0]],
        status=stated,
    )
    intelligence.build(mid)
    assert facts_of(mid)[0]["status"] == stored


def test_an_unusable_response_stores_nothing_instead_of_failing(make_meeting, fake_extract):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    fake_extract["reply"] = "이건 JSON이 아닙니다"
    assert intelligence.build(mid) == 0


# ---------------------------------------------------------------- deadlines


def test_a_deadline_is_kept_verbatim_and_only_resolved_when_it_is_unambiguous(
    make_meeting, fake_extract
):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="문서 정리", source_segment_ids=[seg[0]],
        deadline_text="가능한 한 빨리",
    )
    intelligence.build(mid)
    fact = facts_of(mid)[0]
    assert fact["deadline_text"] == "가능한 한 빨리"
    assert fact["deadline_at"] is None  # never invented


@pytest.mark.parametrize(
    "text,expected",
    [
        ("오늘", dt.date(2026, 8, 19)),          # a Wednesday
        ("내일까지", dt.date(2026, 8, 20)),
        ("모레", dt.date(2026, 8, 21)),
        ("2026-09-01", dt.date(2026, 9, 1)),
        ("2026년 9월 1일까지", dt.date(2026, 9, 1)),
        # No year was stated. Neither candidate is what was said, and rolling a
        # past date forward invents a deadline a year from anything spoken.
        ("9월 1일까지", None),
        ("8월 10일까지", None),
        ("1월 5일까지", None),
        ("금요일까지", dt.date(2026, 8, 21)),
        ("다음 주 금요일", dt.date(2026, 8, 28)),
        ("가능한 한 빨리", None),
        ("이달 말까지", None),
        (None, None),
    ],
)
def test_relative_deadlines_resolve_only_when_there_is_one_reading(text, expected):
    assert intelligence.deadline_date(text, dt.date(2026, 8, 19)) == expected


def occurred(meeting_id, column="coalesce(held_at, created_at)"):
    with conn() as c:
        return c.execute(
            f"SELECT ({column})::date AS d FROM meetings WHERE id = %s", (meeting_id,)
        ).fetchone()["d"]


def test_a_relative_deadline_resolves_against_when_the_meeting_was_held(
    make_meeting, fake_extract
):
    """Uploaded today, held ten days ago. "내일까지" was said in the meeting, so
    it is the day after the meeting - not the day after the upload."""
    mid = make_meeting("API 회의", REQUEST_MEETING, days_ago=0, held_ago=10)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="문서 정리", source_segment_ids=[seg[0]],
        deadline_text="내일까지",
    )
    intelligence.build(mid)
    stored = facts_of(mid)[0]["deadline_at"]
    assert stored == occurred(mid) + dt.timedelta(days=1)
    assert stored != occurred(mid, "created_at") + dt.timedelta(days=1)


def test_a_meeting_with_no_held_at_resolves_against_its_registration_date(
    make_meeting, fake_extract
):
    """A legacy meeting has no held_at. The fallback is deterministic rather
    than a crash - and it is the only date the system actually has."""
    mid = make_meeting("API 회의", REQUEST_MEETING, days_ago=4)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="문서 정리", source_segment_ids=[seg[0]],
        deadline_text="내일까지",
    )
    intelligence.build(mid)
    assert facts_of(mid)[0]["deadline_at"] == occurred(mid, "created_at") + dt.timedelta(days=1)


# ------------------------------------------------------- windows and rebuild


def test_a_long_transcript_is_extracted_in_overlapping_windows(make_meeting, fake_extract):
    lines = [("SPEAKER_00", f"{i}번 발언입니다.") for i in range(90)]
    mid = make_meeting("긴 회의", lines)
    intelligence.build(mid)
    assert len(fake_extract["prompts"]) > 1
    # the overlap really overlaps: the last line of window 1 reappears in window 2
    tail = fake_extract["prompts"][0].splitlines()[-1]
    assert tail in fake_extract["prompts"][1]


def test_the_same_fact_seen_by_two_windows_is_stored_once(make_meeting, fake_extract):
    lines = [("SPEAKER_00", f"{i}번 발언입니다.") for i in range(90)]
    mid = make_meeting("긴 회의", lines)
    seg, _ = parts(mid)
    same = reply(fact_type="DECISION", content="같은 결정", source_segment_ids=[seg[0]])
    fake_extract["reply"] = same
    intelligence.build(mid)
    assert len(facts_of(mid)) == 1


def test_every_fact_is_embedded_at_the_column_width(make_meeting, fake_extract, column_dim):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="문서 정리", source_segment_ids=[seg[0]]
    )
    intelligence.build(mid)
    with conn() as c:
        assert c.execute(
            "SELECT vector_dims(embedding) d FROM meeting_facts WHERE meeting_id = %s",
            (mid,),
        ).fetchone()["d"] == column_dim


def test_a_rebuild_replaces_the_previous_facts(make_meeting, fake_extract):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="DECISION", content="처음 결정", source_segment_ids=[seg[0]]
    )
    intelligence.build(mid)
    fake_extract["reply"] = reply(
        fact_type="DECISION", content="다시 뽑은 결정", source_segment_ids=[seg[1]]
    )
    intelligence.build(mid)
    stored = facts_of(mid)
    assert [f["content"] for f in stored] == ["다시 뽑은 결정"]


def test_a_failed_rebuild_leaves_the_facts_that_were_already_there(
    make_meeting, fake_extract, monkeypatch
):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, _ = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="DECISION", content="지켜져야 할 결정", source_segment_ids=[seg[0]]
    )
    intelligence.build(mid)

    def boom(system, user):
        raise RuntimeError("LLM down")

    monkeypatch.setattr(intelligence, "_complete", boom)
    intelligence.run_build(mid)  # the background entry point: a state, not a crash

    assert [f["content"] for f in facts_of(mid)] == ["지켜져야 할 결정"]
    with conn() as c:
        row = c.execute(
            "SELECT status, intelligence_state, intelligence_error FROM meetings"
            " WHERE id = %s",
            (mid,),
        ).fetchone()
    # the approved meeting is still approved and still searchable
    assert row["status"] == "COMPLETED"
    assert row["intelligence_state"] == "FAILED"
    assert "LLM down" in row["intelligence_error"]


def test_deleting_a_meeting_deletes_its_facts_and_participants(make_meeting, fake_extract):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    seg, spk = parts(mid)
    fake_extract["reply"] = reply(
        fact_type="REQUEST", content="문서 정리", source_segment_ids=[seg[0]],
        requester_speaker_id=spk["화자 A"],
    )
    intelligence.build(mid)
    fact_id = facts_of(mid)[0]["id"]

    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = %s", (mid,))
        assert c.execute(
            "SELECT count(*) n FROM meeting_facts WHERE id = %s", (fact_id,)
        ).fetchone()["n"] == 0
        assert c.execute(
            "SELECT count(*) n FROM meeting_fact_participants WHERE fact_id = %s",
            (fact_id,),
        ).fetchone()["n"] == 0


def test_a_claim_refuses_a_second_concurrent_build(make_meeting):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    assert intelligence.claim(mid) is True
    assert intelligence.claim(mid) is False


# ------------------------------------------------------- user <-> speaker


def test_a_user_claims_a_speaker_and_the_meeting_reports_it_back(make_meeting, client):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    _, spk = parts(mid)
    res = client.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 B"]})
    assert res.status_code == 200
    assert client.get(f"/api/meetings/{mid}").json()["my_speaker_id"] == spk["화자 B"]

    client.put(f"/api/meetings/{mid}/me", json={"speaker_id": None})
    assert client.get(f"/api/meetings/{mid}").json()["my_speaker_id"] is None


def test_a_speaker_from_another_meeting_cannot_be_claimed(make_meeting, client):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    other = make_meeting("다른 회의", [("SPEAKER_00", "관계없는 이야기입니다.")])
    _, other_spk = parts(other)
    res = client.put(f"/api/meetings/{mid}/me", json={"speaker_id": other_spk["화자 A"]})
    assert res.status_code == 400
    assert client.get(f"/api/meetings/{mid}").json()["my_speaker_id"] is None


def test_two_users_cannot_be_the_same_speaker(make_meeting, login):
    mid = make_meeting("API 회의", REQUEST_MEETING)
    _, spk = parts(mid)
    first, second = login(), login()
    assert first.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 A"]}).status_code == 200
    assert second.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 A"]}).status_code == 409


def test_the_mapping_belongs_to_the_session_user_not_the_request(make_meeting, login):
    """Nothing in the body names a user, so a client cannot map somebody else."""
    mid = make_meeting("API 회의", REQUEST_MEETING)
    _, spk = parts(mid)
    mine, theirs = login(), login()
    mine.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 A"]})
    # even sending a user_id changes nothing: the field does not exist
    theirs.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 B"], "user_id": mine.account["id"]})

    assert mine.get(f"/api/meetings/{mid}").json()["my_speaker_id"] == spk["화자 A"]
    assert theirs.get(f"/api/meetings/{mid}").json()["my_speaker_id"] == spk["화자 B"]


def test_a_speaker_can_be_claimed_after_approval(make_meeting, client):
    """Identity is not transcript text, so the approval gate does not bind it."""
    mid = make_meeting("API 회의", REQUEST_MEETING)  # COMPLETED
    _, spk = parts(mid)
    assert client.put(f"/api/meetings/{mid}/me", json={"speaker_id": spk["화자 A"]}).status_code == 200


# ------------------------------------------------------------- meeting date


def test_the_meeting_date_can_be_set_read_back_and_cleared(client, make_meeting):
    """The minimum surface: a meeting is uploaded without one, and an operator
    has to be able to say when it was actually held - and to take it back."""
    mid = make_meeting("회의", REQUEST_MEETING)
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"] is None

    res = client.put(f"/api/meetings/{mid}/held-at", json={"held_at": "2026-08-21T14:00:00+09:00"})
    assert res.status_code == 200
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"].startswith("2026-08-21")

    assert client.put(f"/api/meetings/{mid}/held-at", json={"held_at": None}).status_code == 200
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"] is None


def test_a_meeting_date_that_is_not_a_date_is_refused(client, make_meeting):
    mid = make_meeting("회의", REQUEST_MEETING)
    assert client.put(f"/api/meetings/{mid}/held-at", json={"held_at": "언젠가"}).status_code == 422
    assert client.put("/api/meetings/0/held-at", json={"held_at": None}).status_code == 404
