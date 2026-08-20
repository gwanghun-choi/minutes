"""The meeting lifecycle: the HITL review gate, re-embedding, and deletion.

The contract under test: an AI transcript is a draft, and no chunk or embedding
exists until a human approves the meeting. Re-embedding replays the same
post-approval indexing over the stored transcript, without re-running analysis.
Deletion removes the meeting and everything it owns, in the database and on disk.

The DB-backed tests talk to the real `minutes` schema configured in `.env`, which
is what makes the transaction and duplicate-approval contracts meaningful. They
create their own meeting and delete it afterwards. They skip when the database is
unreachable so the suite still runs offline. The embedding model is faked — this
verifies wiring, not embedding quality.
"""
import pytest
from fastapi.testclient import TestClient

from app.services import chunking, embedding, pipeline

# ---------------------------------------------------------------- DB fixtures


def _db_available() -> bool:
    try:
        from app.db import conn, init_pool

        init_pool()
        with conn() as c:
            c.execute("SELECT 1")
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _db_available(), reason="minutes database is not reachable"
)

def _column_dim() -> int:
    """The live vector width, read from the column so no model has to load."""
    from app import config
    from app.db import conn

    with conn() as c:
        row = c.execute(
            "SELECT a.atttypmod AS dim FROM pg_attribute a"
            " JOIN pg_class t ON t.oid = a.attrelid"
            " JOIN pg_namespace n ON n.oid = t.relnamespace"
            " WHERE n.nspname = %s AND t.relname = 'chunks' AND a.attname = 'embedding'",
            (config.DB_SCHEMA,),
        ).fetchone()
    return row["dim"]


@pytest.fixture(autouse=True)
def fake_embeddings(monkeypatch):
    """Never load BGE-M3 in tests. Vectors only need to be well-formed."""
    dim = _column_dim()
    monkeypatch.setattr(embedding, "encode", lambda texts: [[0.1] * dim for _ in texts])
    monkeypatch.setattr(embedding, "encode_one", lambda text: [0.1] * dim)


@pytest.fixture
def meeting():
    """A meeting sitting at the review gate, with a two-speaker draft transcript."""
    from app.db import conn

    with conn() as c:
        m = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status)"
            " VALUES ('pytest HITL', 'x.wav', 'x.wav', 'UPLOADED') RETURNING id"
        ).fetchone()
    mid = m["id"]

    pipeline._persist_transcript(
        mid,
        [
            {"start": 0.0, "end": 4.0, "text": "예산은 얼마인가요?", "speaker": "SPEAKER_00"},
            {"start": 4.0, "end": 9.0, "text": "삼백만원입니다.", "speaker": "SPEAKER_01"},
            {"start": 9.0, "end": 13.0, "text": "확인했습니다.", "speaker": "SPEAKER_00"},
        ],
    )
    pipeline.set_status(mid, "REVIEW_REQUIRED")
    yield mid

    with conn() as c:
        c.execute("DELETE FROM meetings WHERE id = %s", (mid,))


def _row(meeting_id):
    from app.db import conn

    with conn() as c:
        return c.execute(
            "SELECT status, error_message,"
            " (SELECT count(*) FROM chunks WHERE meeting_id = m.id) AS chunk_count"
            " FROM meetings m WHERE m.id = %s",
            (meeting_id,),
        ).fetchone()


@pytest.fixture
def client():
    """TestClient without the lifespan: the pool and schema already exist."""
    from app.main import app

    return TestClient(app)


# ---------------------------------------------------------------- the gate


def test_analysis_stops_at_the_review_gate_without_indexing(meeting, monkeypatch):
    """The draft is persisted, and chunking/embedding are never reached."""
    called = []
    monkeypatch.setattr(chunking, "build_chunks", lambda *a, **k: called.append("chunk") or [])
    monkeypatch.setattr(embedding, "encode", lambda texts: called.append("embed") or [])

    row = _row(meeting)
    assert row["status"] == "REVIEW_REQUIRED"
    assert row["chunk_count"] == 0
    assert called == []

    utterances, names = pipeline.load_transcript(meeting)
    assert len(utterances) == 3
    assert names == {"SPEAKER_00": "화자 A", "SPEAKER_01": "화자 B"}


def test_unapproved_meeting_is_not_retrievable(meeting, client):
    """The status predicate, not a missing embedding, is what excludes it.

    A fully-formed, embedded chunk is planted on a REVIEW_REQUIRED meeting; it
    must still be invisible to retrieval.
    """
    from app.db import conn
    from app.services import rag

    with conn() as c:
        c.execute(
            "INSERT INTO chunks (meeting_id, sequence, content, start_time, end_time,"
            " speaker_codes, embedding) VALUES (%s,0,'화자 A: 예산은 삼백만원',0,9,"
            " '{SPEAKER_00}',%s)",
            (meeting, [0.1] * _column_dim()),
        )
        planted = c.execute(
            "SELECT count(*) n FROM chunks WHERE meeting_id = %s AND embedding IS NOT NULL",
            (meeting,),
        ).fetchone()
    assert planted["n"] == 1  # the row exists and is embedded

    assert rag.search("예산", meeting_id=meeting) == []
    # also absent from whole-corpus search (other, approved meetings may match)
    assert all(r["meeting_id"] != meeting for r in rag.search("예산", top_k=12))

    body = client.post("/api/chat", json={"question": "예산", "meeting_id": meeting}).json()
    assert body["sources"] == []


# ---------------------------------------------------------------- review edits


def test_reviewer_can_edit_text_and_reassign_speaker(meeting, client):
    from app.db import conn

    with conn() as c:
        speakers = c.execute(
            "SELECT id, speaker_code FROM speakers WHERE meeting_id = %s ORDER BY speaker_code",
            (meeting,),
        ).fetchall()
    second = speakers[1]["id"]

    res = client.patch(
        f"/api/meetings/{meeting}/transcript",
        json={"segments": [{"sequence": 0, "text": "예산은 총 얼마인가요?", "speaker_id": second}]},
    )
    assert res.status_code == 200 and res.json()["updated"] == 1

    utterances, _ = pipeline.load_transcript(meeting)
    assert utterances[0]["text"] == "예산은 총 얼마인가요?"
    assert utterances[0]["speaker"] == "SPEAKER_01"
    assert utterances[1]["text"] == "삼백만원입니다."  # untouched


def test_display_name_edit_survives_a_redraft(meeting):
    """Re-persisting a draft must not discard a reviewer's speaker naming."""
    from app.db import conn

    with conn() as c:
        c.execute(
            "UPDATE speakers SET display_name = '김팀장'"
            " WHERE meeting_id = %s AND speaker_code = 'SPEAKER_00'",
            (meeting,),
        )

    pipeline._persist_transcript(
        meeting,
        [{"start": 0.0, "end": 4.0, "text": "다시 만든 초안", "speaker": "SPEAKER_00"}],
    )

    _, names = pipeline.load_transcript(meeting)
    assert names["SPEAKER_00"] == "김팀장"


def test_edits_are_rejected_outside_the_review_gate(meeting, client):
    pipeline.set_status(meeting, "COMPLETED")
    res = client.patch(
        f"/api/meetings/{meeting}/transcript",
        json={"segments": [{"sequence": 0, "text": "무단 수정"}]},
    )
    assert res.status_code == 409


def test_speaker_rename_is_gated_server_side(meeting, client):
    """An approved transcript is immutable, and the API — not just the UI — says so."""
    from app.db import conn

    with conn() as c:
        sid = c.execute(
            "SELECT id FROM speakers WHERE meeting_id = %s ORDER BY speaker_code LIMIT 1",
            (meeting,),
        ).fetchone()["id"]

    ok = client.patch(
        f"/api/meetings/{meeting}/speakers/{sid}", json={"display_name": "김팀장"}
    )
    assert ok.status_code == 200 and ok.json()["display_name"] == "김팀장"

    pipeline.set_status(meeting, "COMPLETED")
    blocked = client.patch(
        f"/api/meetings/{meeting}/speakers/{sid}", json={"display_name": "이사님"}
    )
    assert blocked.status_code == 409

    with conn() as c:
        assert c.execute(
            "SELECT display_name FROM speakers WHERE id = %s", (sid,)
        ).fetchone()["display_name"] == "김팀장"  # unchanged


# ---------------------------------------------------------------- approval


def test_approval_indexes_the_edited_transcript(meeting, client):
    client.patch(
        f"/api/meetings/{meeting}/transcript",
        json={"segments": [{"sequence": 1, "text": "예산은 정확히 삼백오십만원입니다."}]},
    )

    assert client.post(f"/api/meetings/{meeting}/approve").status_code == 200

    row = _row(meeting)
    assert row["status"] == "COMPLETED"
    assert row["chunk_count"] > 0

    from app.db import conn

    with conn() as c:
        content = c.execute(
            "SELECT content FROM chunks WHERE meeting_id = %s ORDER BY sequence", (meeting,)
        ).fetchall()
    joined = "\n".join(r["content"] for r in content)
    # the reviewer's correction, not the AI draft, is what became RAG evidence
    assert "삼백오십만원" in joined
    assert "삼백만원입니다." not in joined
    assert "화자 A:" in joined  # provenance rendering preserved


def test_duplicate_approval_does_not_duplicate_chunks(meeting, client):
    assert client.post(f"/api/meetings/{meeting}/approve").status_code == 200
    first = _row(meeting)["chunk_count"]

    second = client.post(f"/api/meetings/{meeting}/approve")
    assert second.status_code == 409
    assert _row(meeting)["chunk_count"] == first


def test_approval_requires_the_review_state(meeting, client):
    pipeline.set_status(meeting, "TRANSCRIBING")
    assert client.post(f"/api/meetings/{meeting}/approve").status_code == 409
    assert _row(meeting)["chunk_count"] == 0


def test_approved_meeting_becomes_retrievable(meeting, client):
    from app.services import rag

    client.post(f"/api/meetings/{meeting}/approve")
    assert rag.search("예산", meeting_id=meeting)


# ---------------------------------------------------------------- failure


def test_indexing_failure_preserves_the_transcript_and_allows_retry(meeting, monkeypatch):
    def boom(texts):
        raise RuntimeError("embedding backend down")

    monkeypatch.setattr(embedding, "encode", boom)
    pipeline.set_status(meeting, "INDEXING")
    pipeline.index_transcript(meeting)

    row = _row(meeting)
    assert row["status"] == "REVIEW_REQUIRED"      # retryable, not a dead end
    assert row["chunk_count"] == 0                 # no partial index left behind
    assert "인덱싱 실패" in row["error_message"]

    utterances, _ = pipeline.load_transcript(meeting)
    assert len(utterances) == 3                    # transcript intact


# ---------------------------------------------------------------- re-embedding


def _snapshot(meeting_id):
    """Everything a re-embed must leave alone, plus the index it replaces."""
    from app.db import conn

    with conn() as c:
        return {
            "chunks": c.execute(
                "SELECT id, content FROM chunks WHERE meeting_id = %s ORDER BY sequence",
                (meeting_id,),
            ).fetchall(),
            "segments": c.execute(
                "SELECT sequence, text, speaker_id, start_time, end_time"
                " FROM transcript_segments WHERE meeting_id = %s ORDER BY sequence",
                (meeting_id,),
            ).fetchall(),
            "speakers": c.execute(
                "SELECT id, speaker_code, display_name FROM speakers"
                " WHERE meeting_id = %s ORDER BY speaker_code",
                (meeting_id,),
            ).fetchall(),
        }


def test_reindex_rebuilds_chunks_from_the_current_transcript(meeting, client):
    """The index is rebuilt from what the database holds now, and only the index
    changes: transcript segments and speakers come out byte-identical."""
    from app.db import conn

    assert client.post(f"/api/meetings/{meeting}/approve").status_code == 200
    old_chunks = _snapshot(meeting)["chunks"]
    assert old_chunks

    # A correction written straight to the database, as a later migration or an
    # operator would. A re-embed must pick it up; a cached draft would not.
    with conn() as c:
        c.execute(
            "UPDATE transcript_segments SET text = '예산은 사백만원입니다.'"
            " WHERE meeting_id = %s AND sequence = 1",
            (meeting,),
        )
    before = _snapshot(meeting)

    res = client.post(f"/api/meetings/{meeting}/reindex")
    assert res.status_code == 200
    assert res.json()["status"] == "INDEXING"   # the transition the caller sees

    row = _row(meeting)
    assert row["status"] == "COMPLETED"
    assert row["error_message"] is None

    after = _snapshot(meeting)
    with conn() as c:
        embedded = c.execute(
            "SELECT count(*) n FROM chunks WHERE meeting_id = %s AND embedding IS NOT NULL",
            (meeting,),
        ).fetchone()

    assert after["chunks"]
    assert embedded["n"] == len(after["chunks"])                 # every chunk re-embedded
    assert not {r["id"] for r in after["chunks"]} & {r["id"] for r in old_chunks}  # replaced
    joined = "\n".join(r["content"] for r in after["chunks"])
    assert "사백만원" in joined and "삼백만원" not in joined     # read from the database
    assert after["segments"] == before["segments"]               # transcript untouched
    assert after["speakers"] == before["speakers"]               # names untouched


def test_reindex_never_runs_stt_or_diarization(meeting, client, monkeypatch):
    """Re-embedding is not re-analysis: no audio is opened and no analysis model
    is loaded. A clean COMPLETED with no error is what proves none of them ran —
    index_transcript catches everything, so status alone would not."""
    from app.services import audio, diarization, transcription

    client.post(f"/api/meetings/{meeting}/approve")

    def forbidden(*args, **kwargs):
        raise AssertionError("re-embedding must not touch audio or the analysis models")

    monkeypatch.setattr(audio, "to_wav16k", forbidden)
    monkeypatch.setattr(audio, "duration_seconds", forbidden)
    monkeypatch.setattr(transcription, "transcribe", forbidden)
    monkeypatch.setattr(diarization, "diarize", forbidden)

    assert client.post(f"/api/meetings/{meeting}/reindex").status_code == 200
    row = _row(meeting)
    assert row["status"] == "COMPLETED"
    assert row["error_message"] is None


def test_reindex_requires_an_approved_meeting(meeting, client):
    """Only COMPLETED. A draft has nothing to re-embed, and a run in flight
    must not be restarted underneath itself."""
    assert client.post(f"/api/meetings/{meeting}/reindex").status_code == 409
    assert _row(meeting)["chunk_count"] == 0

    client.post(f"/api/meetings/{meeting}/approve")
    pipeline.set_status(meeting, "INDEXING")
    assert client.post(f"/api/meetings/{meeting}/reindex").status_code == 409

    assert client.post("/api/meetings/999999999/reindex").status_code == 404


def test_only_one_reindex_can_claim_a_meeting(meeting, client):
    """Two requests racing on the same meeting: the compare-and-set lets exactly
    one through, so a double click cannot index twice."""
    from fastapi import HTTPException

    from app.api.meetings import _claim_for_indexing

    client.post(f"/api/meetings/{meeting}/approve")

    _claim_for_indexing(meeting, "COMPLETED", "재임베딩")        # first request wins
    with pytest.raises(HTTPException) as raised:
        _claim_for_indexing(meeting, "COMPLETED", "재임베딩")    # second sees INDEXING
    assert raised.value.status_code == 409
    assert _row(meeting)["status"] == "INDEXING"


def test_reindexed_meeting_is_retrievable_with_provenance(meeting, client):
    from app.services import rag

    client.post(f"/api/meetings/{meeting}/approve")
    assert client.post(f"/api/meetings/{meeting}/reindex").status_code == 200

    hits = rag.search("예산", meeting_id=meeting)
    assert hits
    source = rag.serialize_sources(hits)[0]
    assert source["meeting_id"] == meeting
    assert source["meeting_title"] and source["speakers"]
    assert source["time_label"] and source["text"]
    assert source["score"] is not None


def test_reindex_failure_keeps_the_existing_index(meeting, client, monkeypatch):
    """Embedding runs before the transaction that swaps the chunks, so a failure
    leaves the previous index whole and the meeting searchable."""
    client.post(f"/api/meetings/{meeting}/approve")
    before = _snapshot(meeting)
    assert before["chunks"]

    def boom(texts):
        raise RuntimeError("embedding backend down")

    monkeypatch.setattr(embedding, "encode", boom)
    assert client.post(f"/api/meetings/{meeting}/reindex").status_code == 200

    row = _row(meeting)
    assert row["status"] == "COMPLETED"          # not sent back to the review gate
    assert "인덱싱 실패" in row["error_message"]
    assert "기존 검색 인덱스는 그대로 유지됩니다." in row["error_message"]

    after = _snapshot(meeting)
    assert after["chunks"] == before["chunks"]        # no partial delete
    assert after["segments"] == before["segments"]    # transcript never at risk


# ---------------------------------------------------------------- deletion


@pytest.fixture
def audio_files(meeting):
    """A real pair of files on disk for the meeting, as an upload leaves behind.

    Teardown is idempotent, so a test that deletes them successfully and one that
    fails halfway both leave UPLOAD_DIR clean.
    """
    import uuid

    from app import config
    from app.db import conn

    stored = f"pytest_{uuid.uuid4().hex}.m4a"
    src = config.UPLOAD_DIR / stored
    wav = src.with_suffix(".16k.wav")
    src.write_bytes(b"original audio")
    wav.write_bytes(b"normalized audio")
    with conn() as c:
        c.execute(
            "UPDATE meetings SET stored_filename = %s WHERE id = %s", (stored, meeting)
        )
    yield src, wav
    src.unlink(missing_ok=True)
    wav.unlink(missing_ok=True)


def _counts(meeting_id):
    from app.db import conn

    with conn() as c:
        return c.execute(
            "SELECT (SELECT count(*) FROM meetings WHERE id = %(m)s) AS meetings,"
            " (SELECT count(*) FROM speakers WHERE meeting_id = %(m)s) AS speakers,"
            " (SELECT count(*) FROM transcript_segments WHERE meeting_id = %(m)s) AS segments,"
            " (SELECT count(*) FROM chunks WHERE meeting_id = %(m)s) AS chunks",
            {"m": meeting_id},
        ).fetchone()


def test_delete_removes_the_meeting_its_rows_and_its_files(meeting, audio_files, client):
    """One DELETE closes the whole lifecycle: the row, everything cascading off
    it, and both files on disk."""
    src, wav = audio_files
    client.post(f"/api/meetings/{meeting}/approve")

    before = _counts(meeting)
    assert before["meetings"] == 1 and before["speakers"] == 2
    assert before["segments"] == 3 and before["chunks"] > 0
    assert src.is_file() and wav.is_file()

    res = client.delete(f"/api/meetings/{meeting}")
    assert res.status_code == 200 and res.json()["deleted"] is True

    after = _counts(meeting)
    assert after["meetings"] == 0          # the row itself
    assert after["speakers"] == 0          # ON DELETE CASCADE
    assert after["segments"] == 0          # ON DELETE CASCADE
    assert after["chunks"] == 0            # ON DELETE CASCADE, embeddings with them
    assert not src.exists() and not wav.exists()

    assert client.get(f"/api/meetings/{meeting}").status_code == 404


def test_delete_leaves_other_meetings_alone(meeting, client):
    from app.db import conn

    with conn() as c:
        other = c.execute(
            "INSERT INTO meetings (title, original_filename, stored_filename, status)"
            " VALUES ('pytest neighbour', 'y.wav', 'y.wav', 'UPLOADED') RETURNING id"
        ).fetchone()["id"]
    try:
        pipeline._persist_transcript(
            other, [{"start": 0.0, "end": 3.0, "text": "옆 회의", "speaker": "SPEAKER_00"}]
        )
        pipeline.set_status(other, "REVIEW_REQUIRED")
        client.post(f"/api/meetings/{other}/approve")
        neighbour = _counts(other)
        assert neighbour["chunks"] > 0

        client.post(f"/api/meetings/{meeting}/approve")
        assert client.delete(f"/api/meetings/{meeting}").status_code == 200

        assert _counts(other) == neighbour   # untouched, rows and chunks alike
    finally:
        with conn() as c:
            c.execute("DELETE FROM meetings WHERE id = %s", (other,))


def test_delete_unknown_meeting_is_404(client):
    assert client.delete("/api/meetings/999999999").status_code == 404


def test_delete_is_refused_while_a_background_task_runs(meeting, client):
    """Deleting mid-analysis would pull the row out from under a running task and
    could leave the normalized WAV behind. Refused rather than cancelled."""
    for status in ("UPLOADED", "TRANSCRIBING", "DIARIZING", "INDEXING"):
        pipeline.set_status(meeting, status)
        assert client.delete(f"/api/meetings/{meeting}").status_code == 409, status
        assert _counts(meeting)["meetings"] == 1, status

    pipeline.set_status(meeting, "FAILED")          # a settled state does allow it
    assert client.delete(f"/api/meetings/{meeting}").status_code == 200
    assert _counts(meeting)["meetings"] == 0


def test_delete_succeeds_when_the_audio_is_already_gone(meeting, audio_files, client):
    """Missing files are not an error: the point of the call is the meeting."""
    src, wav = audio_files
    src.unlink()
    wav.unlink()

    assert client.delete(f"/api/meetings/{meeting}").status_code == 200
    assert _counts(meeting)["meetings"] == 0


def test_delete_cannot_reach_outside_the_upload_directory(meeting, client):
    """A stored_filename that tries to escape UPLOAD_DIR deletes nothing outside
    it. Real uploads are server-named, so this guards the path helper itself."""
    from app import config
    from app.db import conn
    from app.services import audio

    canary = config.UPLOAD_DIR.parent / "pytest_canary.wav"
    canary.write_bytes(b"must survive")
    try:
        with conn() as c:
            c.execute(
                "UPDATE meetings SET stored_filename = %s WHERE id = %s",
                ("../pytest_canary.wav", meeting),
            )
        assert audio.meeting_files("../pytest_canary.wav") == []

        assert client.delete(f"/api/meetings/{meeting}").status_code == 200
        assert _counts(meeting)["meetings"] == 0
        assert canary.is_file()          # nothing outside UPLOAD_DIR was touched
    finally:
        canary.unlink(missing_ok=True)
