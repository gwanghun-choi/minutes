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

const JSON_HEADERS = { "Content-Type": "application/json" };

// A TIMESTAMPTZ from the API into what <input type="datetime-local"> accepts,
// in the browser's own timezone. toISOString() is UTC, so shift first.
function toLocalInput(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  // The server, not the page, decides who is logged in. A 401 means the session
  // is gone (expired, or logged out in another tab) — go and get a new one.
  if (res.status === 401 && location.pathname !== "/login") {
    location.href = "/login";
    throw new Error("로그인이 필요합니다.");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

function post(url, body) {
  return api(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
}

/* ---------- login ---------- */
function initLogin() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#login-msg");
    msg.textContent = "";
    try {
      await post("/api/auth/login", {
        username: $("#username").value, password: $("#password").value,
      });
      location.href = "/";
    } catch (err) {
      msg.textContent = err.message;
    }
  });
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
  // A settled state is one where no background task is running: polling stops
  // there, so a redraw cannot land on top of what a reviewer is typing, and it
  // is the same set the server accepts a delete in (anything else is a 409).
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
    // Polling redraws every 2s; overwriting the field the operator is editing
    // would delete what they just typed.
    if (document.activeElement !== $("#m-held")) {
      $("#m-held").value = m.held_at ? toLocalInput(m.held_at) : "";
    }
    $("#m-duration").textContent = fmtTime(m.duration);
    $("#m-lang").textContent = m.language || "-";
    $("#m-speakers").textContent = data.speakers.length || "-";
    $("#m-status").innerHTML =
      `<span class="badge ${m.status}">${STATUS_LABEL[m.status] || m.status}</span>`;
    $("#m-error").textContent = m.error_message || "";
    $("#review-panel").hidden = !review;
    $("#admin-actions").hidden = !SETTLED.includes(m.status);
    $("#reindex-btn").hidden = m.status !== "COMPLETED";
    // Only an approved meeting has a summary: a draft one would carry the same
    // authority as the reviewed one while resting on unchecked text.
    if (m.status === "COMPLETED" && $("#summary-panel").hidden) {
      $("#summary-panel").hidden = false;
      loadSummary(id);
    }

    // Facts come out of the approved transcript, so the panel is COMPLETED-only —
    // the same rule the summary follows, for the same reason.
    $("#intel-panel").hidden = m.status !== "COMPLETED";
    if (m.status === "COMPLETED") loadIntelligence(id);

    renderSpeakers(id, data.speakers, review, data.my_speaker_id, tick);
    renderTranscript(data.segments, data.speakers, m.status, review);
    if (SETTLED.includes(m.status)) clearInterval(timer);
  };
  poll();
  tick();

  // held_at is when the meeting happened; created_at is only when it was
  // uploaded. Everything time-ordered reads the first and falls back to the
  // second, so this field is the only place the real date can be stated.
  $("#held-btn").onclick = async () => {
    const v = $("#m-held").value;
    $("#held-msg").textContent = "저장 중…";
    try {
      await api(`/api/meetings/${id}/held-at`, {
        method: "PUT", headers: JSON_HEADERS,
        body: JSON.stringify({ held_at: v ? new Date(v).toISOString() : null }),
      });
      $("#held-msg").textContent = v
        ? "저장했습니다. 이미 추출된 기한은 [정보 재생성] 후에 다시 계산됩니다."
        : "회의 일시를 지웠습니다. 정렬은 등록일로 대체됩니다.";
    } catch (err) {
      $("#held-msg").textContent = "저장 실패: " + err.message;
    }
  };

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
    const msg = $("#admin-msg");
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

  // AI 후보정: suggestions only. Nothing is written until the reviewer presses
  // 수정 내용 저장, which is the same PATCH that has always saved edits.
  $("#correct-btn").onclick = async () => {
    const msg = $("#review-msg"), box = $("#correction-box");
    $("#correct-btn").disabled = true;
    msg.textContent = "AI 후보정 중…";
    box.innerHTML = "";
    try {
      const { suggestions } = await post(`/api/meetings/${id}/corrections`);
      msg.textContent = suggestions.length
        ? `후보정 제안 ${suggestions.length}건`
        : "고칠 부분을 찾지 못했습니다.";
      if (!suggestions.length) return;
      box.innerHTML = `
        ${suggestions.map((s, i) => `
          <div class="fix">
            <span class="n">${i + 1}</span>
            <div><span class="lbl">변경 전</span> ${escapeHtml(s.before)}</div>
            <div><span class="lbl">변경 후</span> <b>${escapeHtml(s.after)}</b></div>
          </div>`).join("")}
        <button type="button" id="apply-fix">후보정 반영</button>
        <span class="msg">반영 후 "수정 내용 저장"을 눌러야 저장됩니다.</span>`;
      $("#apply-fix").onclick = () => {
        let applied = 0;
        suggestions.forEach((s) => {
          const row = document.querySelector(`#transcript [data-seq="${s.sequence}"] .seg-text`);
          if (row) { row.value = s.after; applied += 1; }
        });
        box.innerHTML = "";
        msg.textContent = `${applied}건을 회의록에 반영했습니다. 저장해야 반영이 유지됩니다.`;
      };
    } catch (err) {
      msg.textContent = "AI 후보정 실패: " + err.message;
    } finally {
      $("#correct-btn").disabled = false;
    }
  };

  $("#summary-btn").onclick = async () => {
    const msg = $("#summary-msg");
    $("#summary-btn").disabled = true;
    msg.textContent = "요약 생성 중…";
    try {
      const row = await post(`/api/meetings/${id}/summary`);
      showSummary(row);
      msg.textContent = "요약을 생성했습니다.";
    } catch (err) {
      msg.textContent = "요약 실패: " + err.message;
    } finally {
      $("#summary-btn").disabled = false;
    }
  };

  // Extraction runs in the background and the meeting is already settled, so the
  // page polls this one panel until the state stops being BUILDING.
  $("#intel-btn").onclick = async () => {
    const msg = $("#intel-msg");
    $("#intel-btn").disabled = true;
    msg.textContent = "정보 생성 중…";
    try {
      await post(`/api/meetings/${id}/intelligence/rebuild`);
      const watch = setInterval(async () => {
        if (await loadIntelligence(id) !== "BUILDING") {
          clearInterval(watch);
          $("#intel-btn").disabled = false;
        }
      }, 3000);
    } catch (err) {
      msg.textContent = "정보 생성 실패: " + err.message;
      $("#intel-btn").disabled = false;
    }
  };

  $("#delete-btn").onclick = async () => {
    if (!confirm("이 회의와 회의록, 검색 인덱스, 업로드 음성이 삭제됩니다.\n" +
                 "되돌릴 수 없습니다.")) return;
    const msg = $("#admin-msg");
    $("#delete-btn").disabled = true;
    msg.textContent = "삭제 중…";
    try {
      await api(`/api/meetings/${id}`, { method: "DELETE" });
      location.href = "/";
    } catch (err) {
      msg.textContent = "삭제 실패: " + err.message;
      $("#delete-btn").disabled = false;
    }
  };
}

function showSummary(row) {
  $("#summary-body").textContent = row.content;
  $("#summary-body").classList.remove("msg");
  $("#summary-btn").textContent = "요약 다시 생성";
}

async function loadSummary(id) {
  try {
    showSummary(await api(`/api/meetings/${id}/summary`));
  } catch {
    // 404 until one is generated - the placeholder text already says so.
  }
}

const INTEL_STATE = {
  NOT_BUILT: "생성 안 됨", BUILDING: "생성 중…", READY: "준비됨", FAILED: "실패",
};
const FACT_LABEL = { REQUEST: "요청", DECISION: "결정", ACTION_ITEM: "Action Item" };
const ROLE_LABEL = { REQUESTER: "요청자", ASSIGNEE: "담당자", DECIDER: "결정자" };
// UNKNOWN is not "open". The meeting simply never said, and the panel has to
// show that rather than let a reader read it as still outstanding.
const FACT_STATUS = {
  UNKNOWN: "상태 미확인", OPEN: "진행 중", DONE: "완료", CANCELLED: "취소", DEFERRED: "연기",
};

// Every fact shows the words it came from. A structured claim with no original
// text under it is not evidence, and the reviewer has to be able to check it.
async function loadIntelligence(id) {
  const data = await api(`/api/meetings/${id}/intelligence`);
  const n = (type) => data.facts.filter((f) => f.fact_type === type).length;
  $("#intel-state").textContent = `상태: ${INTEL_STATE[data.state] || data.state}`
    + (data.state === "READY"
       ? ` · 요청 ${n("REQUEST")} · 결정 ${n("DECISION")} · Action Item ${n("ACTION_ITEM")}`
       : "");
  $("#intel-msg").textContent = data.error || "";
  $("#intel-facts").innerHTML = data.facts.map((f) => {
    const who = Object.entries(f.participants)
      .map(([role, name]) => `${ROLE_LABEL[role] || role}: ${escapeHtml(name)}`);
    if (f.deadline_text) {
      who.push(`기한: ${escapeHtml(f.deadline_text)}`
               + (f.deadline_at ? ` (${escapeHtml(f.deadline_at)})` : ""));
    }
    who.push(FACT_STATUS[f.status] || f.status);
    who.push(`${fmtTime(f.start_time)} ~ ${fmtTime(f.end_time)}`);
    who.push(`발화 ${f.source_segment_ids.join(", ")}`);
    return `
      <div class="fact">
        <h4><span class="badge">${FACT_LABEL[f.fact_type] || f.fact_type}</span>
          ${escapeHtml(f.content)}</h4>
        <div class="sub">${who.join(" · ")}</div>
        <pre>${escapeHtml(f.source_text)}</pre>
      </div>`;
  }).join("") || '<p class="msg">추출된 정보가 없습니다.</p>';
  return data.state;
}

// Same speaker, same colour, everywhere on the page. Colour is never the only
// cue: the display name is always rendered next to it.
const SPEAKER_COLORS = 8;

function speakerClasses(speakers) {
  return new Map(speakers.map((s, i) => [s.speaker_code, `spk-${i % SPEAKER_COLORS}`]));
}

// `mine` is which speaker the logged-in user is. Renaming stops at the review
// gate because it changes the minutes; claiming a speaker does not, so it stays
// available after approval.
function renderSpeakers(meetingId, speakers, editable, mine, refresh) {
  const box = $("#speaker-editor");
  const key = speakers.map((s) => `${s.id}:${s.display_name}`).join("|") + `:${editable}:${mine}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const colors = speakerClasses(speakers);
  box.innerHTML = speakers.map((s) => `
    <span class="spk-row">
      <input class="${colors.get(s.speaker_code)}" data-sid="${s.id}"
             value="${escapeHtml(s.display_name || s.speaker_code)}"
             title="${escapeHtml(s.speaker_code)}" ${editable ? "" : "disabled"}>
      <button type="button" class="ghost me-btn ${s.id === mine ? "on" : ""}" data-me="${s.id}">
        ${s.id === mine ? "나 ✓" : "나로 지정"}</button>
    </span>`).join("");
  box.querySelectorAll("input").forEach((inp) => {
    inp.onchange = () => api(`/api/meetings/${meetingId}/speakers/${inp.dataset.sid}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ display_name: inp.value }),
    });
  });
  box.querySelectorAll("[data-me]").forEach((btn) => {
    btn.onclick = async () => {
      const sid = Number(btn.dataset.me);
      $("#speaker-msg").textContent = "";
      try {
        // Clicking the one already claimed clears it. The server takes the user
        // from the session, so the body only ever names a speaker.
        await api(`/api/meetings/${meetingId}/me`, {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ speaker_id: sid === mine ? null : sid }),
        });
        await refresh();
      } catch (err) {
        $("#speaker-msg").textContent = "화자 지정 실패: " + err.message;
      }
    };
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
  const colors = speakerClasses(speakers);
  const cls = (s) => colors.get(s.speaker_code) || "";
  if (!editable) {
    box.innerHTML = segments.map((s) => `
      <div class="utt ${cls(s)}">
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
    <div class="utt ${cls(s)}" data-seq="${s.sequence}">
      <span class="time">${fmtTime(s.start_time)} ~ ${fmtTime(s.end_time)}</span>
      <select class="seg-speaker">${options(s.speaker_code)}</select>
      <textarea class="seg-text" rows="1">${escapeHtml(s.text)}</textarea>
    </div>`).join("");
}

/* ---------- chat ---------- */
// One chat session at a time. The sidebar lists the rest; the server owns them.
const SCOPE_HINT = "선택하지 않으면 전체 회의를 검색합니다.";

async function initChat() {
  const conv = $("#conversation"), modal = $("#scope-modal");
  let sid = null;              // open chat session
  let scope = [];              // meeting ids; empty = the whole corpus
  let picked = new Set();      // modal selection, only applied on 선택 완료
  let days = "";               // modal date filter
  let lastQuestion = "";
  // Only approved meetings can be searched, so only they can be scoped to.
  const meetings = (await api("/api/meetings")).filter((m) => m.status === "COMPLETED");

  const showScope = () => {
    $("#scope-label").textContent = scope.length ? `선택한 회의 ${scope.length}개` : "전체 회의";
  };

  const bucket = (iso) => {
    const d = (Date.now() - new Date(iso)) / 86400000;
    return d < 1 ? "오늘" : d < 7 ? "이전 7일" : "이전";
  };

  const loadList = async () => {
    const rows = await api("/api/chat/sessions");
    const groups = [];
    rows.forEach((r) => {
      const b = bucket(r.updated_at);
      if (!groups.length || groups[groups.length - 1].name !== b) groups.push({ name: b, rows: [] });
      groups[groups.length - 1].rows.push(r);
    });
    $("#chat-list").innerHTML = groups.map((g) => `
      <h4>${g.name}</h4>
      ${g.rows.map((r) => `
        <div class="chat-item ${r.id === sid ? "on" : ""}" data-open="${r.id}">
          <span>${escapeHtml(r.title)}</span>
          <button type="button" class="ghost" data-del="${r.id}" title="대화 삭제">✕</button>
        </div>`).join("")}`).join("") || '<p class="msg">아직 대화가 없습니다.</p>';

    $("#chat-list").querySelectorAll("[data-open]").forEach((el) => {
      el.onclick = (e) => {
        if (e.target.dataset.del) return;
        open(Number(el.dataset.open));
      };
    });
    $("#chat-list").querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("이 대화를 삭제합니다. 되돌릴 수 없습니다.")) return;
        const id = Number(btn.dataset.del);
        await api(`/api/chat/sessions/${id}`, { method: "DELETE" });
        if (id === sid) { sid = null; conv.innerHTML = ""; }
        await (sid ? loadList() : start());
      };
    });
  };

  // A structured source still renders its original words in <pre>: the summary
  // line is the claim, the excerpt underneath is what it rests on.
  const sourcesHtml = (sources) => (sources || []).map((s) => `
    <div class="source">
      <h4>[${s.index}] ${s.kind === "fact" ? `<span class="badge">${FACT_LABEL[s.fact_type] || s.fact_type}</span> ` : ""}${escapeHtml(s.meeting_title)}</h4>
      ${s.kind === "fact" ? `<div class="sub">${escapeHtml(s.summary)}${
        s.deadline_text ? ` · 기한: ${escapeHtml(s.deadline_text)}` : ""
      }${s.status_label ? ` · ${escapeHtml(s.status_label)}` : ""}${
        s.meeting_date_label ? ` · ${escapeHtml(s.meeting_date_label)}` : ""}</div>` : ""}
      <div class="sub">화자: ${escapeHtml((s.speakers || []).join(", ")) || "-"} · ${s.time_label}
        · 유사도 ${s.score}</div>
      <pre>${escapeHtml(s.text)}</pre>
    </div>`).join("");

  const render = (messages) => {
    conv.innerHTML = messages.map((m) => m.role === "user"
      ? `<div class="turn user">${escapeHtml(m.content)}</div>`
      : `<div class="turn bot"><div class="answer">${escapeHtml(m.content)}</div>
           ${sourcesHtml(m.sources)}</div>`).join("")
      || '<p class="msg">질문을 입력하세요.</p>';
    conv.scrollTop = conv.scrollHeight;
  };

  const open = async (id) => {
    const data = await api(`/api/chat/sessions/${id}`);
    sid = data.session.id;
    scope = data.session.scope_meeting_ids || [];
    showScope();
    render(data.messages);
    await loadList();
  };

  const create = async (initialScope) => {
    const s = await post("/api/chat/sessions", { scope_meeting_ids: initialScope || [] });
    sid = s.id;
    scope = s.scope_meeting_ids || [];
    showScope();
    render([]);
    await loadList();
  };

  const start = async () => {
    const rows = await api("/api/chat/sessions");
    return rows.length ? open(rows[0].id) : create([]);
  };

  const ask = async (question, globalOverride) => {
    lastQuestion = question;
    conv.insertAdjacentHTML("beforeend",
      `<div class="turn user">${escapeHtml(question)}</div>
       <div class="turn bot"><div class="answer msg">검색 중…</div></div>`);
    conv.scrollTop = conv.scrollHeight;
    const data = await post(`/api/chat/sessions/${sid}/messages`,
      { question, global_override: !!globalOverride });
    await open(sid);
    if (data.scope_miss) {
      // The backend already answered within the chosen scope and stopped there.
      // Widening the search is a click, never something that happens quietly.
      conv.insertAdjacentHTML("beforeend", `
        <div class="fallback">
          선택한 회의에서는 해당 내용을 찾지 못했습니다.<br>전체 회의에서 다시 찾아볼까요?
          <button type="button" id="global-retry">전체 회의에서 검색</button>
        </div>`);
      conv.scrollTop = conv.scrollHeight;
      $("#global-retry").onclick = () => ask(lastQuestion, true);
    }
    await loadList();
  };

  $("#chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button"), input = $("#question");
    const question = input.value.trim();
    if (!question) return;
    btn.disabled = true;
    input.value = "";
    try {
      await ask(question, false);
    } catch (err) {
      conv.insertAdjacentHTML("beforeend",
        `<div class="turn bot"><div class="answer error">실패: ${escapeHtml(err.message)}</div></div>`);
    } finally {
      btn.disabled = false;
    }
  });

  $("#new-chat").onclick = () => create([]);

  /* ---- scope picker: a searchable, date-filtered list instead of a select box ---- */
  const renderOptions = () => {
    const q = $("#scope-search").value.trim().toLowerCase();
    const cutoff = days ? Date.now() - Number(days) * 86400000 : null;
    const rows = meetings.filter((m) =>
      (!q || m.title.toLowerCase().includes(q)) &&
      (!cutoff || new Date(m.held_at || m.created_at) >= cutoff));
    $("#scope-options").innerHTML = rows.map((m) => `
      <label class="scope-opt">
        <input type="checkbox" value="${m.id}" ${picked.has(m.id) ? "checked" : ""}>
        <span>${escapeHtml((m.held_at || m.created_at).slice(0, 10))} ${escapeHtml(m.title)}</span>
      </label>`).join("") || '<p class="msg">해당하는 회의가 없습니다.</p>';
    $("#scope-options").querySelectorAll("input").forEach((box) => {
      box.onchange = () => box.checked ? picked.add(Number(box.value)) : picked.delete(Number(box.value));
    });
  };

  // One way out, used by ✕, the backdrop, ESC, and a successful save. Closing
  // discards `picked`: nothing is applied that the server has not accepted.
  const closeScope = () => { modal.hidden = true; };

  $("#scope-btn").onclick = () => {
    picked = new Set(scope);
    $("#scope-search").value = "";
    $("#scope-msg").textContent = SCOPE_HINT;
    renderOptions();
    modal.hidden = false;
  };
  $("#scope-close").onclick = closeScope;
  modal.onclick = (e) => { if (e.target === modal) closeScope(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeScope();
  });
  $("#scope-search").oninput = renderOptions;
  $(".filters").querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      days = btn.dataset.days;
      $(".filters").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
      renderOptions();
    };
  });
  // The server is what makes a scope real. Only a saved scope closes the dialog
  // and reaches `scope`; a failure leaves both the session and the picker alone.
  $("#scope-apply").onclick = async () => {
    const next = [...picked], btn = $("#scope-apply");
    btn.disabled = true;
    $("#scope-msg").textContent = "저장 중…";
    try {
      await api(`/api/chat/sessions/${sid}`, {
        method: "PATCH", headers: JSON_HEADERS,
        body: JSON.stringify({ scope_meeting_ids: next }),
      });
      scope = next;
      showScope();
      closeScope();
    } catch (err) {
      $("#scope-msg").textContent = "범위 저장 실패: " + err.message;
    } finally {
      btn.disabled = false;
    }
  };

  const preset = new URLSearchParams(location.search).get("meeting_id");
  await (preset ? create([Number(preset)]) : start());
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- logout (present on every authenticated page) ---------- */
document.getElementById("logout-btn")?.addEventListener("click", async () => {
  await post("/api/auth/logout").catch(() => {});
  location.href = "/login";
});
