"""Meeting categories, and the meeting date that comes with an upload.

Both are metadata about a meeting rather than a word of its transcript, so both
are editable at any status. The contracts worth pinning here are the ones the
database owns — a duplicate name is refused, and deleting a category unfiles its
meetings instead of deleting them — plus the one rule about legacy data: an
upload may propose today, but nothing backfills a meeting that never said when
it was held.
"""
import datetime as dt

import pytest
from conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def category(client):
    """Factory for throwaway categories. Removed at teardown, meetings intact."""
    from app.db import conn

    ids: list[int] = []

    def make(name: str) -> dict:
        res = client.post("/api/meeting-categories", json={"name": name})
        assert res.status_code == 200, res.text
        ids.append(res.json()["id"])
        return res.json()

    yield make

    with conn() as c:
        c.execute("DELETE FROM meeting_categories WHERE id = ANY(%s)", (ids,))


def _unique(name: str) -> str:
    import secrets

    return f"{name} {secrets.token_hex(4)}"


def test_a_category_is_created_and_listed(client, category):
    name = _unique("고객 미팅")
    made = category(name)
    assert made["name"] == name

    rows = client.get("/api/meeting-categories").json()
    mine = next(r for r in rows if r["id"] == made["id"])
    assert mine["meeting_count"] == 0


def test_a_blank_name_is_refused(client):
    assert client.post("/api/meeting-categories", json={"name": "   "}).status_code == 400


def test_a_duplicate_name_is_a_conflict_not_a_second_row(client, category):
    name = _unique("개발")
    category(name)
    res = client.post("/api/meeting-categories", json={"name": name})
    assert res.status_code == 409
    assert "이미" in res.json()["detail"]


def test_a_category_can_be_renamed(client, category):
    made = category(_unique("내부 업무"))
    renamed = _unique("내부 운영")
    res = client.patch(f"/api/meeting-categories/{made['id']}", json={"name": renamed})
    assert res.status_code == 200
    assert res.json()["name"] == renamed


def test_renaming_onto_an_existing_name_is_a_conflict(client, category):
    first = category(_unique("A"))
    second = category(_unique("B"))
    res = client.patch(f"/api/meeting-categories/{second['id']}", json={"name": first["name"]})
    assert res.status_code == 409


def test_an_unknown_category_is_a_404(client):
    assert client.patch("/api/meeting-categories/0", json={"name": "x"}).status_code == 404
    assert client.delete("/api/meeting-categories/0").status_code == 404


def test_a_meeting_is_filed_and_unfiled(client, category, make_meeting):
    made = category(_unique("프로젝트 A"))
    mid = make_meeting("pytest 분류", [("SPEAKER_00", "분류 테스트입니다.")])

    res = client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})
    assert res.status_code == 200
    assert res.json() == {"id": mid, "category_id": made["id"], "category_name": made["name"]}

    # The list and the detail both carry it, so no screen has to look it up.
    row = next(m for m in client.get("/api/meetings").json() if m["id"] == mid)
    assert (row["category_id"], row["category_name"]) == (made["id"], made["name"])
    detail = client.get(f"/api/meetings/{mid}").json()["meeting"]
    assert detail["category_name"] == made["name"]

    cleared = client.put(f"/api/meetings/{mid}/category", json={"category_id": None})
    assert cleared.json() == {"id": mid, "category_id": None, "category_name": None}


def test_an_unknown_category_cannot_be_assigned(client, make_meeting):
    mid = make_meeting("pytest 잘못된 분류", [("SPEAKER_00", "테스트.")])
    res = client.put(f"/api/meetings/{mid}/category", json={"category_id": 2_000_000_000})
    assert res.status_code == 400


def test_deleting_a_category_leaves_its_meetings_alone(client, make_meeting):
    made = client.post("/api/meeting-categories", json={"name": _unique("삭제될 분류")}).json()
    mid = make_meeting("pytest 보존", [("SPEAKER_00", "회의는 남아야 합니다.")])
    client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})

    assert client.delete(f"/api/meeting-categories/{made['id']}").status_code == 200

    detail = client.get(f"/api/meetings/{mid}")
    assert detail.status_code == 200
    assert detail.json()["meeting"]["category_id"] is None
    assert detail.json()["meeting"]["category_name"] is None


def test_the_count_reflects_how_many_meetings_would_be_unfiled(client, category, make_meeting):
    made = category(_unique("계수"))
    mid = make_meeting("pytest 계수", [("SPEAKER_00", "하나.")])
    client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})

    rows = client.get("/api/meeting-categories").json()
    assert next(r for r in rows if r["id"] == made["id"])["meeting_count"] == 1


def test_categories_need_a_session(anon):
    assert anon.get("/api/meeting-categories").status_code == 401
    assert anon.post("/api/meeting-categories", json={"name": "x"}).status_code == 401


# ---------- held_at on upload ----------


def _upload(client, **form):
    """A one-byte .wav is enough: the response is written before analysis runs."""
    return client.post(
        "/api/meetings",
        files={"file": ("pytest-held.wav", b"\x00", "audio/wav")},
        data=form,
    )


@pytest.fixture
def uploaded():
    """Cleans up whatever an upload test created, row and file both."""
    from app.db import conn
    from app.services import audio

    ids: list[int] = []
    yield ids
    with conn() as c:
        for row in c.execute(
            "DELETE FROM meetings WHERE id = ANY(%s) RETURNING stored_filename", (ids,)
        ).fetchall():
            for path in audio.meeting_files(row["stored_filename"]):
                path.unlink(missing_ok=True)


def test_an_upload_can_carry_the_meeting_date(client, uploaded):
    res = _upload(client, title="pytest 일시 있음", held_at="2026-08-18T14:30:00+09:00")
    assert res.status_code == 200, res.text
    uploaded.append(res.json()["id"])
    assert dt.datetime.fromisoformat(res.json()["held_at"]) == dt.datetime(
        2026, 8, 18, 5, 30, tzinfo=dt.timezone.utc
    )


def test_an_upload_without_a_date_stays_null(client, uploaded):
    """No DB default of now(): an unstated meeting date is NULL, not the upload
    time wearing a different name."""
    res = _upload(client, title="pytest 일시 없음")
    assert res.status_code == 200, res.text
    uploaded.append(res.json()["id"])
    assert res.json()["held_at"] is None

    blank = _upload(client, title="pytest 빈 일시", held_at="")
    uploaded.append(blank.json()["id"])
    assert blank.json()["held_at"] is None


def test_a_malformed_date_is_refused_rather_than_guessed(client):
    res = _upload(client, title="pytest 잘못된 일시", held_at="지난주 화요일")
    assert res.status_code == 400


def test_a_legacy_meeting_keeps_a_null_held_at(client, make_meeting):
    """make_meeting with no held_ago is the legacy shape. Nothing in the upload
    or category paths may fill it in."""
    mid = make_meeting("pytest legacy", [("SPEAKER_00", "예전 회의입니다.")])
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"] is None

    # Filing it does not invent a date either.
    made = client.post("/api/meeting-categories", json={"name": _unique("legacy")}).json()
    client.put(f"/api/meetings/{mid}/category", json={"category_id": made["id"]})
    assert client.get(f"/api/meetings/{mid}").json()["meeting"]["held_at"] is None
    client.delete(f"/api/meeting-categories/{made['id']}")
