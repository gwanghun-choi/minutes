const $ = (sel) => document.querySelector(sel);

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
      <td><span class="badge ${m.status}">${m.status}</span></td>
    </tr>`).join("");
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.onclick = () => (location.href = "/meetings/" + tr.dataset.id);
  });
}

/* ---------- meeting detail ---------- */
function initMeeting(id) {
  const tick = async () => {
    const data = await api("/api/meetings/" + id);
    const m = data.meeting;
    $("#m-title").textContent = m.title;
    $("#m-file").textContent = m.original_filename;
    $("#m-duration").textContent = fmtTime(m.duration);
    $("#m-lang").textContent = m.language || "-";
    $("#m-speakers").textContent = data.speakers.length || "-";
    $("#m-status").innerHTML = `<span class="badge ${m.status}">${m.status}</span>`;
    $("#m-error").textContent = m.error_message || "";
    renderSpeakers(id, data.speakers);
    renderTranscript(data.segments, m.status);
    if (["COMPLETED", "FAILED"].includes(m.status)) clearInterval(timer);
  };
  const timer = setInterval(tick, 2000);
  tick();
}

function renderSpeakers(meetingId, speakers) {
  const box = $("#speaker-editor");
  if (box.dataset.count === String(speakers.length)) return;
  box.dataset.count = speakers.length;
  box.innerHTML = speakers.map((s) =>
    `<input data-sid="${s.id}" value="${escapeHtml(s.display_name || s.speaker_code)}"
            title="${s.speaker_code}">`).join("");
  box.querySelectorAll("input").forEach((inp) => {
    inp.onchange = () => api(`/api/meetings/${meetingId}/speakers/${inp.dataset.sid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: inp.value }),
    });
  });
}

function renderTranscript(segments, status) {
  const box = $("#transcript");
  if (!segments.length) {
    box.innerHTML = `<p class="msg">${status === "COMPLETED" ? "발화가 없습니다." :
      "분석 중입니다 (" + status + ")…"}</p>`;
    return;
  }
  box.innerHTML = segments.map((s) => `
    <div class="utt">
      <span class="time">${fmtTime(s.start_time)} ~ ${fmtTime(s.end_time)}</span>
      <span class="spk">${escapeHtml(s.display_name || s.speaker_code || "-")}</span>
      <span>${escapeHtml(s.text)}</span>
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
