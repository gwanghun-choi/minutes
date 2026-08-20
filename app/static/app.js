const $ = (sel) => document.querySelector(sel);

const STATUS_LABEL = {
  UPLOADED: "업로드됨",
  TRANSCRIBING: "음성 인식 중",
  DIARIZING: "화자 분리 중",
  REVIEW_REQUIRED: "검토 필요",
  INDEXING: "인덱싱 중",
  COMPLETED: "완료",
  FAILED: "실패",
};


function fmtTime(sec) {
  if (sec == null) return "-";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

/* ---------- index ---------- */
function initIndex() {
  const form = $("#upload-form"), msg = $("#upload-msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    msg.textContent = "업로드 중…";
    try {
      await api("/api/meetings", { method: "POST", body: new FormData(form) });
      msg.textContent = "업로드 완료. 분석이 시작되었습니다.";
      form.reset();
      loadMeetings();
    } catch (err) {
      msg.textContent = "실패: " + err.message;
    } finally {
      btn.disabled = false;
    }
  });
  loadMeetings();
  setInterval(loadMeetings, 3000);
}

async function loadMeetings() {
  const rows = await api("/api/meetings");
  const tbody = $("#meeting-table tbody");
  tbody.innerHTML = rows.map((m) => `
    <tr class="clickable" data-id="${m.id}">
      <td>${m.id}</td><td>${escapeHtml(m.title)}</td>
      <td>${escapeHtml(m.original_filename)}</td>
      <td>${fmtTime(m.duration)}</td><td>${m.speaker_count || "-"}</td>
      <td><span class="badge ${m.status}">${STATUS_LABEL[m.status] || m.status}</span></td>
    </tr>`).join("");
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.onclick = () => (location.href = "/meetings/" + tr.dataset.id);
  });
}

/* ---------- meeting detail / transcript review ---------- */
function initMeeting(id) {
  // Polling stops at every state where only a human can move things forward, so a
  // redraw can never land on top of what a reviewer is typing.
  const SETTLED = ["REVIEW_REQUIRED", "COMPLETED", "FAILED"];
  let timer = null;
  const poll = () => {
    clearInterval(timer);
    timer = setInterval(tick, 2000);
  };

  const tick = async () => {
    const data = await api("/api/meetings/" + id);
    const m = data.meeting;
    const review = m.status === "REVIEW_REQUIRED";
    $("#m-title").textContent = m.title;
    $("#m-file").textContent = m.original_filename;
    $("#m-duration").textContent = fmtTime(m.duration);
    $("#m-lang").textContent = m.language || "-";
    $("#m-speakers").textContent = data.speakers.length || "-";
    $("#m-status").innerHTML =
      `<span class="badge ${m.status}">${STATUS_LABEL[m.status] || m.status}</span>`;
    $("#m-error").textContent = m.error_message || "";
    $("#review-panel").hidden = !review;
    $("#admin-actions").hidden = m.status !== "COMPLETED";

    renderSpeakers(id, data.speakers, review);
    renderTranscript(data.segments, data.speakers, m.status, review);
    if (SETTLED.includes(m.status)) clearInterval(timer);
  };
  poll();
  tick();

  const save = async () => {
    const segments = [...document.querySelectorAll("#transcript [data-seq]")].map((row) => ({
      sequence: Number(row.dataset.seq),
      text: row.querySelector(".seg-text").value,
      speaker_id: Number(row.querySelector(".seg-speaker").value) || null,
    }));
    await api(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments }),
    });
  };

  $("#save-btn").onclick = async () => {
    const msg = $("#review-msg");
    msg.textContent = "저장 중…";
    try {
      await save();
      msg.textContent = "저장했습니다.";
    } catch (err) {
      msg.textContent = "저장 실패: " + err.message;
    }
  };

  // Always save before approving, so unsaved edits can never be silently dropped.
  $("#approve-btn").onclick = async () => {
    const msg = $("#review-msg");
    $("#approve-btn").disabled = true;
    $("#save-btn").disabled = true;
    msg.textContent = "저장 후 승인 중…";
    try {
      await save();
      await api(`/api/meetings/${id}/approve`, { method: "POST" });
      msg.textContent = "승인했습니다. 인덱싱을 시작합니다.";
      poll();
      tick();
    } catch (err) {
      msg.textContent = "승인 실패: " + err.message;
      $("#approve-btn").disabled = false;
    } finally {
      $("#save-btn").disabled = false;
    }
  };

  // Re-embed: chunking and embedding run again over the stored transcript. The
  // transcript itself is never rebuilt, so this needs no audio and no models
  // beyond the embedder. Native confirm() rather than a modal for one dialog.
  $("#reindex-btn").onclick = async () => {
    if (!confirm("승인된 회의록을 기준으로 검색 인덱스를 다시 생성합니다.\n" +
                 "음성 인식과 화자 분리는 다시 실행하지 않습니다.")) return;
    const msg = $("#reindex-msg");
    $("#reindex-btn").disabled = true;
    msg.textContent = "재임베딩 중…";
    try {
      await api(`/api/meetings/${id}/reindex`, { method: "POST" });
      msg.textContent = "재임베딩을 시작했습니다.";
      poll();
      tick();
    } catch (err) {
      msg.textContent = "재임베딩 실패: " + err.message;
    } finally {
      $("#reindex-btn").disabled = false;
    }
  };
}

function renderSpeakers(meetingId, speakers, editable) {
  const box = $("#speaker-editor");
  const key = speakers.map((s) => `${s.id}:${s.display_name}`).join("|") + `:${editable}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = speakers.map((s) =>
    `<input data-sid="${s.id}" value="${escapeHtml(s.display_name || s.speaker_code)}"
            title="${escapeHtml(s.speaker_code)}" ${editable ? "" : "disabled"}>`).join("");
  box.querySelectorAll("input").forEach((inp) => {
    inp.onchange = () => api(`/api/meetings/${meetingId}/speakers/${inp.dataset.sid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: inp.value }),
    });
  });
}

function renderTranscript(segments, speakers, status, editable) {
  const box = $("#transcript");
  if (!segments.length) {
    box.innerHTML = `<p class="msg">${["COMPLETED", "REVIEW_REQUIRED"].includes(status)
      ? "발화가 없습니다."
      : "분석 중입니다 (" + (STATUS_LABEL[status] || status) + ")…"}</p>`;
    return;
  }
  if (!editable) {
    box.innerHTML = segments.map((s) => `
      <div class="utt">
        <span class="time">${fmtTime(s.start_time)} ~ ${fmtTime(s.end_time)}</span>
        <span class="spk">${escapeHtml(s.display_name || s.speaker_code || "-")}</span>
        <span>${escapeHtml(s.text)}</span>
      </div>`).join("");
    return;
  }
  const options = (code) => speakers.map((sp) =>
    `<option value="${sp.id}" ${sp.speaker_code === code ? "selected" : ""}>
       ${escapeHtml(sp.display_name || sp.speaker_code)}</option>`).join("");
  box.innerHTML = segments.map((s) => `
    <div class="utt" data-seq="${s.sequence}">
      <span class="time">${fmtTime(s.start_time)} ~ ${fmtTime(s.end_time)}</span>
      <select class="seg-speaker">${options(s.speaker_code)}</select>
      <textarea class="seg-text" rows="1">${escapeHtml(s.text)}</textarea>
    </div>`).join("");
}

/* ---------- chat ---------- */
async function initChat() {
  const scope = $("#scope");
  const meetings = await api("/api/meetings");
  meetings.filter((m) => m.status === "COMPLETED").forEach((m) => {
    scope.insertAdjacentHTML("beforeend",
      `<option value="${m.id}">${escapeHtml(m.title)}</option>`);
  });
  const preset = new URLSearchParams(location.search).get("meeting_id");
  if (preset) scope.value = preset;

  $("#chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    $("#answer").textContent = "검색 중…";
    $("#sources").innerHTML = "";
    try {
      const data = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: $("#question").value,
          meeting_id: scope.value ? Number(scope.value) : null,
        }),
      });
      $("#answer").textContent = data.answer;
      $("#sources").innerHTML = data.sources.map((s) => `
        <div class="source">
          <h4>[${s.index}] ${escapeHtml(s.meeting_title)}</h4>
          <div class="sub">화자: ${escapeHtml(s.speakers.join(", "))} · ${s.time_label}
            · 유사도 ${s.score}</div>
          <pre>${escapeHtml(s.text)}</pre>
        </div>`).join("") || '<p class="msg">근거를 찾지 못했습니다.</p>';
    } catch (err) {
      $("#answer").textContent = "실패: " + err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
