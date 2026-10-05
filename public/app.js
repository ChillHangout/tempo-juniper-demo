const POLL_MS = 2000;
const FINAL = ["booked", "nobody_available", "too_late", "cancelled", "failed"];
const PHASES = {
  finding: { label: "Starting", tone: "neutral" },
  offering: { label: "Offering", tone: "active" },
  booked: { label: "Booked", tone: "good" },
  nobody_available: { label: "Nobody available", tone: "warn" },
  too_late: { label: "Too late", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  failed: { label: "Needs attention", tone: "bad" },
};
const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

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

const TOOLS_KEY = "juniper.prototypeToolsOpen";
const toolsOpen = () => $("#tools").open;

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
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const slotTitle = (opening) => `${opening.service} with ${opening.stylist}`;
const slotWhen = (opening) => `${day(opening.startsAt)} at ${clock(opening.startsAt)}`;
const firstName = (name) => name.split(" ")[0];

function statusTag(phase) {
  const { label, tone } = PHASES[phase] ?? { label: phase, tone: "neutral" };
  return `<span class="tag ${tone}">${label}</span>`;
}

function remaining(expiresAt) {
  const ms = Math.max(0, Date.parse(expiresAt) - Date.now());
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ringOffset(sentAt, expiresAt) {
  const total = Date.parse(expiresAt) - Date.parse(sentAt);
  const left = Math.max(0, Date.parse(expiresAt) - Date.now());
  const fraction = total > 0 ? left / total : 0;
  return (RING_LENGTH * (1 - fraction)).toFixed(1);
}

function names(list, empty) {
  return list.length
    ? `<ul class="names">${list.map((p) => `<li>${escapeHtml(p.name)}</li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`;
}

function flash(html, kind = "info") {
  const item = document.createElement("div");
  item.className = `notice ${kind}`;
  item.innerHTML = `<span>${html}</span><button type="button" class="dismiss" aria-label="Dismiss">×</button>`;
  item.querySelector("button").addEventListener("click", () => item.remove());
  $("#notices").prepend(item);
}

function renderSummary() {
  const active = state.openings.filter((s) => !FINAL.includes(s.phase)).length;
  const attention = state.openings.filter((s) => s.phase === "failed").length;
  const parts = [
    active === 0 ? "No openings being offered right now" : active === 1 ? "1 opening being offered" : `${active} openings being offered`,
  ];
  if (attention) parts.push(attention === 1 ? "1 needs your attention" : `${attention} need your attention`);
  $("#summary").textContent = parts.join(", ");
}

function railLine(s) {
  if (s.currentOffer) return `${escapeHtml(firstName(s.currentOffer.name))} has the offer`;
  if (s.bookedClient) return `${escapeHtml(s.bookedClient.name)} booked`;
  return PHASES[s.phase]?.label ?? s.phase;
}

function renderOpenings() {
  const list = $("#openings");
  if (!state.openings.length) {
    list.innerHTML = `<li class="empty">No openings yet. When a client cancels, enter the time above and it will be offered to the waitlist.</li>`;
    return;
  }
  list.innerHTML = state.openings
    .map((s) => {
      const tone = PHASES[s.phase]?.tone ?? "neutral";
      return `<li><button type="button" class="opening ${tone} ${s.openingId === state.selectedId ? "selected" : ""}" data-id="${escapeHtml(s.openingId)}"
          aria-current="${s.openingId === state.selectedId}">
        <span class="opening-title">${escapeHtml(slotTitle(s.opening))}</span>
        <span class="opening-when">${escapeHtml(slotWhen(s.opening))}</span>
        <span class="opening-state"><span class="dot" aria-hidden="true"></span>${railLine(s)}</span>
      </button></li>`;
    })
    .join("");
}

function heroFor(s) {
  if (s.currentOffer) {
    const { name, sentAt, expiresAt } = s.currentOffer;
    return `<div class="hero offer">
      <div class="ring" role="timer" aria-label="Time left for ${escapeHtml(name)} to reply">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-track" cx="60" cy="60" r="${RING_RADIUS}" />
          <circle class="ring-fill" cx="60" cy="60" r="${RING_RADIUS}"
            stroke-dasharray="${RING_LENGTH.toFixed(1)}" stroke-dashoffset="${ringOffset(sentAt, expiresAt)}"
            data-sent="${sentAt}" data-expires="${expiresAt}" />
        </svg>
        <span class="ring-time" data-expires="${expiresAt}">${remaining(expiresAt)}</span>
      </div>
      <div>
        <p class="hero-name">${escapeHtml(name)} has the offer</p>
        <p>Texted at ${clock(sentAt)}. If there's no reply by ${clock(expiresAt)}, it goes to the next person.</p>
      </div>
    </div>`;
  }
  if (s.bookedClient) {
    return `<div class="hero good">
      <svg class="hero-mark" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" /><path d="M14 25l7 7 13-15" /></svg>
      <div>
        <p class="hero-name">${escapeHtml(s.bookedClient.name)} is booked</p>
        <p>Add this appointment in Square so the calendar matches.</p>
      </div>
    </div>`;
  }
  const tone = PHASES[s.phase]?.tone ?? "neutral";
  return `<div class="hero ${tone}"><div><p class="hero-name">${escapeHtml(s.headline)}</p></div></div>`;
}

function renderDetail() {
  const el = $("#detail");
  const s = state.openings.find((o) => o.openingId === state.selectedId);
  if (!s) {
    el.innerHTML = `<p class="empty">Choose an opening to see who has the offer and what happens next.</p>`;
    return;
  }
  const finished = FINAL.includes(s.phase);
  const queueHeading = finished ? "Not contacted" : "Up next";
  const queue = s.stillEligible.length
    ? `<ol class="queue">${s.stillEligible.map((p) => `<li>${escapeHtml(p.name)}</li>`).join("")}</ol>`
    : `<p class="muted">${finished ? "Nobody." : "Nobody left after this."}</p>`;

  el.innerHTML = `
    <header class="detail-head">
      <div>
        <h2>${escapeHtml(slotTitle(s.opening))}</h2>
        <p class="muted">${escapeHtml(slotWhen(s.opening))}, ${s.opening.durationMinutes} minutes</p>
      </div>
      ${statusTag(s.phase)}
    </header>
    ${heroFor(s)}
    <div class="lists">
      <div><h3>${queueHeading}</h3>${queue}</div>
      <div><h3>Said no</h3>${names(s.declined, "Nobody yet.")}</div>
      <div><h3>No reply in time</h3>${names(s.timedOut, "Nobody yet.")}</div>
      ${s.couldNotText.length ? `<div><h3>Couldn't text</h3>${names(s.couldNotText, "")}</div>` : ""}
    </div>
    <p class="cutoff">No new offers after ${clock(s.cutoffAt)}, 45 minutes before the appointment, so clients have time to get here.</p>
    ${finished ? "" : `<button type="button" class="quiet-danger" id="cancel-opening">Cancel this opening</button>`}
    <h3>What's happened</h3>
    <ol class="timeline">${s.timeline
      .slice()
      .reverse()
      .map((t) => `<li><time>${clock(t.at)}</time><span>${escapeHtml(t.text)}</span></li>`)
      .join("")}</ol>`;
}

function renderNotices() {
  for (const s of state.openings) {
    for (const n of s.notices) {
      const key = `${s.openingId}|${n.at}|${n.text}`;
      if (state.seenNotices.has(key)) continue;
      state.seenNotices.add(key);
      if (!state.firstLoad) {
        flash(`<strong>${escapeHtml(slotTitle(s.opening))}:</strong> ${escapeHtml(n.text)}`, n.kind);
      }
    }
  }
}

async function renderThread() {
  const thread = $("#thread");
  if (!toolsOpen()) return; // the simulated phone only matters while the drawer is open
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
  for (const el of document.querySelectorAll(".ring-time")) el.textContent = remaining(el.dataset.expires);
  for (const el of document.querySelectorAll(".ring-fill")) {
    el.setAttribute("stroke-dashoffset", ringOffset(el.dataset.sent, el.dataset.expires));
  }
}

async function refresh() {
  try {
    const { openings } = await api("/api/openings");
    state.openings = openings;
    if (!state.selectedId && openings[0]) state.selectedId = openings[0].openingId;
    renderSummary();
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
      demoSpeed: $("#demo-speed").checked,
    };
    const message = $("#form-message");
    try {
      const { openingId } = await api("/api/openings", { method: "POST", body: JSON.stringify(body) });
      state.selectedId = openingId;
      message.className = "form-message ok";
      message.textContent = body.demoSpeed
        ? "Offering to the waitlist with demo speed (30-second offers)."
        : "Offering to the waitlist. Eligible clients are texted one at a time.";
      await refresh();
    } catch (error) {
      message.className = "form-message error";
      message.textContent = error.message;
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
    const reason = window.prompt("Why are you cancelling this opening? (for example: the original client is coming after all)");
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

  // Remember whether the drawer was open; `#tools` in the address opens it too.
  try {
    $("#tools").open = location.hash === "#tools" || localStorage.getItem(TOOLS_KEY) === "open";
  } catch {
    $("#tools").open = location.hash === "#tools";
  }
  const syncLayout = () => $(".layout").classList.toggle("tools-open", toolsOpen());
  syncLayout();
  $("#tools").addEventListener("toggle", async () => {
    syncLayout();
    try {
      localStorage.setItem(TOOLS_KEY, toolsOpen() ? "open" : "closed");
    } catch {
      // Storage can be unavailable (private windows); the drawer still works.
    }
    await renderThread();
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
