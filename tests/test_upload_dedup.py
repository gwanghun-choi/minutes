"""The same recording, uploaded twice by the same account, is one meeting.

Identity is the original file's bytes and the account that owns them — never the
filename, which is a label the uploader chose, and never the content alone,
which would let one account learn that another one holds the same audio.

What is being pinned here is mostly *what does not happen*: no second meeting,
no second row, and above all no second analysis. Everything downstream of the
upload (FFmpeg, faster-whisper, pyannote, BGE-M3, the extraction) is the
expensive part, so the guard is only worth anything if it lands before the
background task is queued.
"""
import hashlib

import pytest
from conftest import requires_db

from app.db import conn

pytestmark = requires_db

AUDIO = b"RIFF0000WAVEpytest-dedup-fixture"
OTHER = b"RIFF0000WAVEpytest-dedup-different"


@pytest.fixture
def upload(client, monkeypatch, tmp_path):
    """Send a real multipart upload, with the analysis stubbed out.

    `UPLOAD_DIR` moves to a temporary directory so the assertions about files
    left behind can count everything in it, and `pipeline.process` is replaced by
    a recorder — the audio phase is not what any of this is about, and a one-byte
    wav would only make ffmpeg fail.
    """
    from app import config
    from app.api import meetings as api

    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path)
    started: list[int] = []
    monkeypatch.setattr(api.pipeline, "process", lambda mid, path: started.append(mid))

    ids: list[int] = []

    def send(as_client=None, filename="회의.wav", data=AUDIO, **form):
        res = (as_client or client).post(
            "/api/meetings", files={"file": (filename, data, "audio/wav")}, data=form,
        )
        if res.status_code == 200:
            ids.append(res.json()["id"])
        return res

    send.started = started
    send.dir = tmp_path
    yield send

    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = ANY(%s)", (ids,))


def _hash(meeting_id: int) -> str | None:
    with conn() as c:
        return c.execute(
            "SELECT source_content_hash FROM meetings WHERE id = %s", (meeting_id,)
        ).fetchone()["source_content_hash"]


def _status(meeting_id: int, status: str) -> None:
    with conn() as c:
        c.execute("UPDATE meetings SET status = %s WHERE id = %s", (status, meeting_id))


# ------------------------------------------------------------------ the hash


def test_an_upload_stores_the_sha256_of_the_bytes_it_was_sent(upload):
    res = upload(title="pytest 최초 업로드")
    assert res.status_code == 200, res.text
    assert _hash(res.json()["id"]) == hashlib.sha256(AUDIO).hexdigest()


def test_the_first_upload_of_a_file_is_analysed(upload):
    res = upload()
    assert upload.started == [res.json()["id"]]


# ------------------------------------------------------------- the duplicate


def test_the_same_bytes_from_the_same_account_are_refused(upload):
    first = upload(title="pytest 원본").json()

    again = upload(title="pytest 사본")
    assert again.status_code == 409
    body = again.json()
    assert body["code"] == "DUPLICATE_MEETING_SOURCE"
    assert body["existing_meeting_id"] == first["id"]
    assert body["existing_meeting_title"] == "pytest 원본"
    assert body["detail"]


def test_a_duplicate_starts_no_analysis(upload):
    first = upload().json()
    upload()
    # The whole point: the second request never reaches the pipeline.
    assert upload.started == [first["id"]]


def test_renaming_the_file_does_not_make_it_a_new_recording(upload):
    upload(filename="회의.wav")
    again = upload(filename="복사본.wav")
    assert again.status_code == 409


def test_the_same_filename_with_different_bytes_is_a_new_meeting(upload):
    first = upload(filename="회의.wav", data=AUDIO).json()
    second = upload(filename="회의.wav", data=OTHER)
    assert second.status_code == 200, second.text
    assert second.json()["id"] != first["id"]
    assert _hash(second.json()["id"]) == hashlib.sha256(OTHER).hexdigest()


def test_a_refused_upload_leaves_no_file_behind(upload):
    upload()
    assert len(list(upload.dir.iterdir())) == 1
    assert upload().status_code == 409
    # Still one: the bytes written while hashing are removed with the refusal.
    assert len(list(upload.dir.iterdir())) == 1


def test_the_message_says_which_state_the_existing_meeting_is_in(upload):
    first = upload().json()

    _status(first["id"], "TRANSCRIBING")
    assert "분석 중" in upload().json()["detail"]

    _status(first["id"], "COMPLETED")
    body = upload().json()
    assert body["detail"] == "이미 등록된 파일입니다."
    assert body["existing_meeting_status"] == "COMPLETED"

    # A failed meeting is not silently replaced: it is still the owner's row, and
    # deleting it is the deliberate act that frees the bytes.
    _status(first["id"], "FAILED")
    assert "삭제" in upload().json()["detail"]


def test_a_conflict_names_the_meeting_by_this_accounts_own_alias(upload, client):
    first = upload(title="pytest 정본 제목").json()
    client.put(f"/api/meetings/{first['id']}/alias", json={"alias": "내가 부르는 이름"})
    assert upload().json()["existing_meeting_title"] == "내가 부르는 이름"


# ------------------------------------------------------------ race condition


def test_two_requests_past_the_same_empty_lookup_still_make_one_meeting(
    upload, monkeypatch
):
    """The SELECT is an optimisation; the unique index is the guarantee.

    Both requests looking and both finding nothing is the interleaving that a
    check-then-insert cannot survive on its own, so the first lookup is blinded
    here to reproduce it. What must not happen is a 500 leaking out of psycopg.
    """
    from app.api import meetings as api

    real = api._duplicate
    seen = {"n": 0}

    def blind(c, owner_id, digest):
        seen["n"] += 1
        return None if seen["n"] == 1 else real(c, owner_id, digest)

    first = upload().json()
    monkeypatch.setattr(api, "_duplicate", blind)

    again = upload()
    assert again.status_code == 409
    assert again.json()["existing_meeting_id"] == first["id"]
    assert upload.started == [first["id"]]

    with conn() as c:
        assert c.execute(
            "SELECT count(*) AS n FROM meetings WHERE source_content_hash = %s"
            "   AND owner_user_id = %s",
            (hashlib.sha256(AUDIO).hexdigest(), first["owner_user_id"]),
        ).fetchone()["n"] == 1


# ---------------------------------------------------------------- isolation


def test_another_account_may_upload_the_same_file(upload, login):
    mine = upload().json()
    theirs = upload(as_client=login())
    assert theirs.status_code == 200, theirs.text
    assert theirs.json()["id"] != mine["id"]


def test_being_given_a_meeting_does_not_make_the_same_file_a_duplicate(
    upload, login, share
):
    """A share grants reading, never a claim on the bytes.

    The recipient can already see the owner's meeting; uploading the same audio
    is them making a meeting of their own, and refusing it would both take that
    away and tell them the two files are identical.
    """
    mine = upload().json()
    reader = login()
    share(mine["id"], reader.account["id"])
    assert reader.get(f"/api/meetings/{mine['id']}").status_code == 200

    theirs = upload(as_client=reader)
    assert theirs.status_code == 200, theirs.text
    assert theirs.json()["owner_user_id"] == reader.account["id"]


def test_a_duplicate_never_names_a_meeting_this_account_cannot_own(upload, login):
    """Somebody else holding the same file is not visible in any form.

    Not as a conflict, not as a title, not as an id — the second account's upload
    simply succeeds, which is the only answer that says nothing about the first.
    """
    upload()
    other = login()
    res = upload(as_client=other)
    assert res.status_code == 200
    assert res.json()["owner_user_id"] == other.account["id"]


# ------------------------------------------------------- delete and legacy


def test_deleting_the_meeting_frees_the_file_to_be_uploaded_again(upload, client):
    first = upload().json()
    assert upload().status_code == 409

    assert client.delete(f"/api/meetings/{first['id']}").status_code == 200

    again = upload()
    assert again.status_code == 200, again.text
    assert again.json()["id"] != first["id"]


def test_meetings_from_before_the_column_existed_collide_with_nothing(
    upload, make_meeting
):
    """A NULL hash takes part in no comparison.

    Two legacy meetings coexist under the partial unique index, and a new upload
    is never told it duplicates one — an unknown hash must never look equal to
    another unknown hash.
    """
    a = make_meeting("pytest 레거시 A", [("SPEAKER_00", "이전 회의")], status="COMPLETED")
    b = make_meeting("pytest 레거시 B", [("SPEAKER_00", "이전 회의")], status="COMPLETED")
    assert _hash(a) is None and _hash(b) is None

    res = upload()
    assert res.status_code == 200, res.text
    assert _hash(res.json()["id"]) is not None
