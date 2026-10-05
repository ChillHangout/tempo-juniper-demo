const POLL_MS = 2000;
const FINAL = ["booked", "nobody_available", "too_late", "cancelled", "failed"];
const PHASES = {
  finding: ["Starting", "neutral"],
  offering: ["Offering", "active"],
  booked: ["Booked", "good"],
  nobody_available: ["Nobody available", "warn"],
  too_late: ["Too late", "warn"],
  cancelled: ["Cancelled", "neutral"],
  failed: ["Needs attention", "bad"],
};

const state = {
  salon: null,
  openings: [],
  selectedId: null,
  phoneClientId: "",
  seenNotices: new Set(),
  firstLoad: true,
  threadSize: 0,
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Something went wrong (${response.status}).`);
  return body;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const slotLabel = (opening) =>
  `${opening.service} with ${opening.stylist} · ${new Date(opening.startsAt).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })}`;

function badge(phase) {
  const [label, tone] = PHASES[phase] ?? [phase, "neutral"];
  return `<span class="badge ${tone}">${label}</span>`;
}

function countdown(expiresAt) {
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return "ending now";
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${String(seconds % 60).padStart(2, "0")} s left` : `${seconds} s left`;
}

function people(list, empty) {
  return list.length
    ? `<ul class="people">${list.map((p) => `<li>${escapeHtml(p.name)}</li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`;
}

function flash(text, kind = "info") {
  const item = document.createElement("div");
  item.className = `notice ${kind}`;
  item.innerHTML = `<span>${text}</span><button type="button" aria-label="Dismiss">×</button>`;
  item.querySelector("button").addEventListener("click", () => item.remove());
  $("#notices").prepend(item);
}

function renderOpenings() {
  const list = $("#openings");
  if (!state.openings.length) {
    list.innerHTML = `<li class="muted">No openings yet. Log a cancellation above.</li>`;
    return;
  }
  list.innerHTML = state.openings
    .map(
      (s) => `<li><button type="button" class="opening ${s.openingId === state.selectedId ? "selected" : ""}" data-id="${escapeHtml(s.openingId)}">
        <span>${escapeHtml(slotLabel(s.opening))}</span>${badge(s.phase)}</button></li>`,
    )
    .join("");
}

function renderDetail() {
  const el = $("#detail");
  const s = state.openings.find((o) => o.openingId === state.selectedId);
  if (!s) {
    el.innerHTML = `<p class="muted">Select an opening to see who has the offer.</p>`;
    return;
  }
  const offer = s.currentOffer
    ? `<div class="offer"><p class="label">Has the offer now</p><p class="big">${escapeHtml(s.currentOffer.name)}</p>
       <p>Offer ends at ${clock(s.currentOffer.expiresAt)} · <span class="countdown" data-expires="${s.currentOffer.expiresAt}">${countdown(s.currentOffer.expiresAt)}</span></p></div>`
    : "";
  const booked = s.bookedClient
    ? `<div class="offer good"><p class="label">Booked</p><p class="big">${escapeHtml(s.bookedClient.name)}</p><p>Remember to update Square.</p></div>`
    : "";
  el.innerHTML = `
    <div class="detail-head"><h2>${escapeHtml(slotLabel(s.opening))}</h2>${badge(s.phase)}</div>
    <p class="headline">${escapeHtml(s.headline)}</p>
    ${offer}${booked}
    <p class="muted">No new offers after ${clock(s.cutoffAt)} (45 minutes before the appointment).</p>
    <div class="columns">
      <div><h3>Next in line</h3>${people(s.stillEligible, "Nobody left to offer.")}</div>
      <div><h3>Declined</h3>${people(s.declined, "None yet.")}</div>
      <div><h3>No reply in time</h3>${people(s.timedOut, "None yet.")}</div>
      ${s.couldNotText.length ? `<div><h3>Couldn't text</h3>${people(s.couldNotText, "")}</div>` : ""}
    </div>
    ${FINAL.includes(s.phase) ? "" : `<button type="button" class="danger" id="cancel-opening">Cancel this opening</button>`}
    <h3>What's happened</h3>
    <ol class="timeline">${s.timeline
      .slice()
      .reverse()
      .map((t) => `<li><time>${clock(t.at)}</time> ${escapeHtml(t.text)}</li>`)
      .join("")}</ol>`;
}

function renderNotices() {
  for (const s of state.openings) {
    for (const n of s.notices) {
      const key = `${s.openingId}|${n.at}|${n.text}`;
      if (state.seenNotices.has(key)) continue;
      state.seenNotices.add(key);
      if (!state.firstLoad) {
        flash(`<strong>${escapeHtml(s.opening.service)} with ${escapeHtml(s.opening.stylist)}:</strong> ${escapeHtml(n.text)}`, n.kind);
      }
    }
  }
}

async function renderThread() {
  const thread = $("#thread");
  if (!state.phoneClientId) {
    thread.innerHTML = `<p class="muted">Choose a client to see the texts they've received.</p>`;
    state.threadSize = 0;
    return;
  }
  const { messages } = await api(`/api/clients/${encodeURIComponent(state.phoneClientId)}/messages`);
  thread.innerHTML = messages.length
    ? messages
        .map(
          (m) => `<div class="bubble ${m.from}"><p>${escapeHtml(m.body)}</p><time>${clock(m.at)}</time>
          ${m.kind === "offer"
            ? `<div class="reply-buttons">
                 <button type="button" data-reply="yes" data-opening="${escapeHtml(m.openingId)}">YES</button>
                 <button type="button" data-reply="no" data-opening="${escapeHtml(m.openingId)}">NO</button>
               </div>`
            : ""}</div>`,
        )
        .join("")
    : `<p class="muted">No texts yet.</p>`;
  if (messages.length !== state.threadSize) thread.scrollTop = thread.scrollHeight;
  state.threadSize = messages.length;
}

function tickCountdowns() {
  for (const el of document.querySelectorAll(".countdown")) el.textContent = countdown(el.dataset.expires);
}

async function refresh() {
  try {
    const { openings } = await api("/api/openings");
    state.openings = openings;
    if (!state.selectedId && openings[0]) state.selectedId = openings[0].openingId;
    renderOpenings();
    renderDetail();
    renderNotices();
    await renderThread();
    $("#connection").hidden = true;
  } catch {
    $("#connection").hidden = false;
  }
}

function defaultStart() {
  const start = new Date(Date.now() + 2 * 60 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    time: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
  };
}

function setUpForm() {
  const form = $("#opening-form");
  form.stylist.innerHTML = state.salon.stylists.map((s) => `<option>${escapeHtml(s)}</option>`).join("");
  form.service.innerHTML = state.salon.services
    .map((s) => `<option value="${escapeHtml(s.name)}" data-minutes="${s.minutes}">${escapeHtml(s.name)}</option>`)
    .join("");
  form.durationMinutes.value = state.salon.services[0]?.minutes ?? 45;
  const { date, time } = defaultStart();
  form.date.value = date;
  form.time.value = time;

  form.service.addEventListener("change", () => {
    form.durationMinutes.value = form.service.selectedOptions[0].dataset.minutes;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      stylist: form.stylist.value,
      service: form.service.value,
      date: form.date.value,
      time: form.time.value,
      durationMinutes: Number(form.durationMinutes.value),
      demoSpeed: form.demoSpeed.checked,
    };
    try {
      const { openingId } = await api("/api/openings", { method: "POST", body: JSON.stringify(body) });
      state.selectedId = openingId;
      $("#form-message").textContent = "Started. Eligible clients will be texted one at a time.";
      await refresh();
    } catch (error) {
      $("#form-message").textContent = error.message;
    }
  });
}

function setUpEvents() {
  $("#openings").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-id]");
    if (!button) return;
    state.selectedId = button.dataset.id;
    renderOpenings();
    renderDetail();
  });

  $("#detail").addEventListener("click", async (event) => {
    if (event.target.id !== "cancel-opening") return;
    const reason = window.prompt("Why are you cancelling? (for example: the original client is coming after all)");
    if (reason === null) return;
    try {
      const result = await api(`/api/openings/${encodeURIComponent(state.selectedId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      flash(escapeHtml(result.message), result.cancelled ? "stopped" : "problem");
    } catch (error) {
      flash(escapeHtml(error.message), "problem");
    }
    await refresh();
  });

  $("#phone-client").innerHTML =
    `<option value="">Choose a client…</option>` +
    state.salon.clients.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  $("#phone-client").addEventListener("change", async (event) => {
    state.phoneClientId = event.target.value;
    $("#phone-message").textContent = "";
    await renderThread();
  });

  $("#thread").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-reply]");
    if (!button) return;
    try {
      const result = await api(`/api/openings/${encodeURIComponent(button.dataset.opening)}/respond`, {
        method: "POST",
        body: JSON.stringify({ clientId: state.phoneClientId, accept: button.dataset.reply === "yes" }),
      });
      $("#phone-message").textContent = `Salon: ${result.message}`;
    } catch (error) {
      $("#phone-message").textContent = error.message;
    }
    await refresh();
  });

  $("#outage").addEventListener("change", async (event) => {
    const { on } = await api("/api/simulate/outage", { method: "POST", body: JSON.stringify({ on: event.target.checked }) });
    event.target.checked = on;
  });
}

async function init() {
  try {
    state.salon = await api("/api/salon");
  } catch {
    $("#connection").hidden = false;
    return;
  }
  setUpForm();
  setUpEvents();
  $("#outage").checked = (await api("/api/simulate/outage")).on;
  await refresh();
  state.firstLoad = false;
  setInterval(refresh, POLL_MS);
  setInterval(tickCountdowns, 1000);
}

init();
