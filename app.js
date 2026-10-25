(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = "studgether.session.v1";
  const NAME_KEY = "studgether.name.v1";
  const CID_KEY = "studgether.cid.v1";
  const BASE_TITLE = "Studgether · shared study timer";
  const statusNames = { studying: "Studying", break: "On a break", away: "Away" };
  const cfg = window.STUDGETHER_CONFIG || {};
  const Net = window.StudgetherNet;
  const HOST_GRACE_MS = 5000;
  const HOST_UNSEEN_MS = 25000;
  const JOIN_TIMEOUT_MS = 40000;

  const state = {
    net: null, code: null, joined: false, cid: null,
    me: null,                 // {name, status, joinedAt}
    room: null,               // shared room state (see adoptState)
    people: new Map(),        // cid -> {name, status, joinedAt, peers:Set}
    peerCid: new Map(),       // peerId -> cid
    offset: 0, tick: null, hostTimer: null, beat: null, messageTimer: null,
    pending: null, lastHostCid: null, hostWasSeen: false, busy: false
  };

  /* ---------- helpers ---------- */
  const trueNow = () => Date.now() + state.offset;       // clock corrected to real time
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function store(kind) { try { return kind === "local" ? window.localStorage : window.sessionStorage; } catch (_) { return null; } }
  const memory = {};
  function sget(k, kind) { const s = store(kind); try { return s ? s.getItem(k) : (memory[k] ?? null); } catch (_) { return memory[k] ?? null; } }
  function sset(k, v, kind) { memory[k] = v; const s = store(kind); try { if (s) s.setItem(k, v); } catch (_) {} }
  function sdel(k, kind) { delete memory[k]; const s = store(kind); try { if (s) s.removeItem(k); } catch (_) {} }
  function randomString(len, chars) {
    const buf = new Uint32Array(len);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    let out = ""; for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }
  const randomCode = () => randomString(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  function showMessage(text, isError = false) {
    const node = $("message");
    node.textContent = text;
    node.style.background = isError ? "#b42318" : "#172033";
    node.classList.add("show");
    clearTimeout(state.messageTimer);
    state.messageTimer = setTimeout(() => node.classList.remove("show"), 4500);
  }
  function setConnection(label, mode = "") {
    const node = $("connectionStatus");
    node.className = "connection " + mode;
    node.innerHTML = '<span class="dot"></span> ' + label;
  }
  function showNotice(title, text) {
    $("noticeTitle").textContent = title;
    $("noticeText").textContent = text;
    $("configNotice").classList.add("error");
    $("configNotice").classList.remove("hidden");
  }
  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function getDurationMinutes() {
    const selected = $("duration").value;
    if (selected === "custom") {
      const n = Number($("customDuration").value);
      if (!Number.isInteger(n) || n < 1 || n > 600) throw new Error("Enter a custom duration between 1 and 600 minutes.");
      return n;
    }
    return Number(selected);
  }
  function safeName(value) {
    const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
    if (!name) throw new Error("Please enter your display name.");
    return name;
  }
  function setBusy(on) { state.busy = on; ["createRoomBtn", "joinRoomBtn"].forEach(id => { $(id).disabled = on; }); }

  /* ---------- real-time clock (no server needed) ----------
     Every website reply carries a "Date" header. Sampling it a few times and
     intersecting the one-second windows gives each device the true time to within
     about a second, even if the device clock is wrong. */
  async function syncClock() {
    if (location.protocol === "file:") return;
    const url = location.href.split("#")[0].split("?")[0];
    let lo = -Infinity, hi = Infinity; const mids = [];
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      try {
        const r = await fetch(url + "?_t=" + t0 + "_" + i, { method: "HEAD", cache: "no-store" });
        const t1 = Date.now();
        const d = Date.parse(r.headers.get("date"));
        if (Number.isFinite(d)) {
          const D = d + (Number(r.headers.get("age")) || 0) * 1000;
          const a = D - t1, b = D + 1000 - t0;
          mids.push((a + b) / 2); lo = Math.max(lo, a); hi = Math.min(hi, b);
        }
      } catch (_) {}
      await sleep(230);
    }
    if (!mids.length) return;
    let off = lo <= hi ? (lo + hi) / 2 : mids.sort((x, y) => x - y)[Math.floor(mids.length / 2)];
    if (Math.abs(off) < 7 * 86400000) { state.offset = off; if (state.joined) renderTimer(); }
  }

  /* ---------- networking ---------- */
  function startNet(code) {
    stopNet();
    state.code = code;
    const net = Net.join({ turn: cfg.turn, trackers: cfg.trackers, nostr: cfg.nostr, loopback: cfg.loopback }, code);
    state.net = net;
    net.onPeerJoin = (peerId) => {
      if (state.net !== net) return;
      if (state.me) sendProfile(peerId);
      if (state.room) sendState(peerId);
      state.people.forEach((p, cid) => { if (p.peers.size) state.net.send({ t: "p", cid, name: p.name, status: p.status, joinedAt: p.joinedAt, r: 1 }, peerId); });
      updateConnection();
    };
    net.onPeerLeave = (peerId) => {
      if (state.net !== net) return;
      state.peerCid.delete(peerId);
      const lostDirect = [], gone = [];
      state.people.forEach((p, id) => {
        const had = p.peers.size;
        p.peers.delete(peerId); p.via.delete(peerId);
        if (had && !p.peers.size) lostDirect.push(id);   // we no longer vouch for them
        if (!p.peers.size && !p.via.size) gone.push(id);
      });
      lostDirect.forEach(id => relay({ t: "b", cid: id, r: 1 }));
      gone.forEach(id => state.people.delete(id));
      renderParticipants(); updateConnection(); scheduleHostCheck();
    };
    net.onMessage = (msg, peerId) => { if (state.net === net) handleMessage(msg, peerId); };
  }
  function stopNet() {
    if (state.net) { try { state.net.leave(); } catch (_) {} }
    state.net = null;
    state.people.clear(); state.peerCid.clear();
    clearTimeout(state.hostTimer); state.hostTimer = null;
  }
  function updateConnection() {
    if (!state.joined) { setConnection(Net ? "Ready" : "Unavailable", Net ? "connected" : "error"); return; }
    const n = state.people.size;
    setConnection(n ? "Connected · " + (n + 1) + " in room" : "Waiting for others", "connected");
  }
  function sendProfile(target) {
    if (!state.net || !state.me) return;
    state.net.send({ t: "p", cid: state.cid, name: state.me.name, status: state.me.status, joinedAt: state.me.joinedAt }, target);
  }
  function sendState(target) {
    if (!state.net || !state.room) return;
    state.net.send(Object.assign({ t: "s" }, state.room), target);
  }
  // Tell everyone we are directly connected to (except `except`), so two friends who
  // cannot reach each other directly still see each other through a common friend.
  function relay(msg, except) {
    if (!state.net) return;
    state.net.peers().forEach(id => { if (id !== except) state.net.send(msg, id); });
  }
  function handleMessage(m, peerId) {
    if (m.t === "p") {
      const cid = typeof m.cid === "string" ? m.cid.slice(0, 40) : "";
      if (!cid || cid === state.cid) return;
      const name = String(m.name || "").trim().replace(/\s+/g, " ").slice(0, 24) || "Participant";
      const status = statusNames[m.status] ? m.status : "studying";
      const joinedAt = Number.isFinite(m.joinedAt) ? m.joinedAt : 0;
      let person = state.people.get(cid);
      if (!person) { person = { peers: new Set(), via: new Set() }; state.people.set(cid, person); }
      Object.assign(person, { name, status, joinedAt });
      if (m.r === 1) person.via.add(peerId);
      else {
        person.peers.add(peerId); state.peerCid.set(peerId, cid);
        relay({ t: "p", cid, name, status, joinedAt, r: 1 }, peerId);
      }
      if (state.room && cid === state.room.hostCid) state.hostWasSeen = true;
      renderParticipants(); updateConnection(); scheduleHostCheck();
    } else if (m.t === "b") {   // "bye": a person closed the page (or a friend lost them)
      const cid = typeof m.cid === "string" ? m.cid.slice(0, 40) : "";
      const person = state.people.get(cid);
      if (person) {
        if (m.r === 1) person.via.delete(peerId);
        else { person.peers.forEach(pid => state.peerCid.delete(pid)); person.peers.clear(); relay({ t: "b", cid, r: 1 }, peerId); }
        if (!person.peers.size && !person.via.size) state.people.delete(cid);
        renderParticipants(); updateConnection(); scheduleHostCheck();
      }
    } else if (m.t === "s") {
      const num = (v) => (Number.isFinite(v) ? v : null);
      const c = {
        rev: Number.isInteger(m.rev) ? m.rev : -1,
        hostCid: typeof m.hostCid === "string" ? m.hostCid.slice(0, 40) : "",
        durationMs: num(m.durationMs), status: m.status,
        startedAt: num(m.startedAt), endAt: num(m.endAt), endedAt: num(m.endedAt)
      };
      if (c.rev < 0 || !c.hostCid || !["waiting", "running", "ended"].includes(c.status)) return;
      if (c.durationMs === null || c.durationMs < 60000 || c.durationMs > 36000000) return;
      adoptState(c);
    }
  }
  function adoptState(c) {
    const cur = state.room;
    if (cur && !(c.rev > cur.rev || (c.rev === cur.rev && c.hostCid < cur.hostCid))) return;
    const hostChanged = !cur || cur.hostCid !== c.hostCid;
    state.room = c;
    if (hostChanged) state.hostWasSeen = state.people.has(c.hostCid) || c.hostCid === state.cid;
    if (state.pending) state.pending(true);
    if (state.joined) { announceHostChange(); persist(); renderRoom(); scheduleHostCheck(); }
  }
  function publishState(fields) {
    state.room = Object.assign({}, state.room, fields, { rev: state.room.rev + 1 });
    sendState(); persist(); renderRoom();
  }

  /* ---------- host logic ---------- */
  const isHostNow = () => !!(state.room && state.room.hostCid === state.cid);
  function announceHostChange() {
    const h = state.room.hostCid;
    if (state.lastHostCid && state.lastHostCid !== h) {
      if (h === state.cid) showMessage("The previous host left. You are now the host.");
      else { const p = state.people.get(h); showMessage((p ? p.name : "Someone") + " is now the host."); }
    }
    state.lastHostCid = h;
  }
  function electionOrder() {
    const list = [[state.cid, state.me.joinedAt]];
    state.people.forEach((p, cid) => list.push([cid, p.joinedAt || 0]));
    return list.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(x => x[0]);
  }
  // If the host is gone for a few seconds (a quick reload is forgiven), the person
  // who has been in the room longest becomes host. Everybody computes the same answer.
  function scheduleHostCheck() {
    if (!state.joined || !state.room) return;
    if (isHostNow() || state.people.has(state.room.hostCid)) { clearTimeout(state.hostTimer); state.hostTimer = null; return; }
    if (state.hostTimer) return;
    // Quick when we watched the host leave; patient when we simply have not met the host
    // yet (e.g. right after our own reload), so a slow reconnect never steals the role.
    state.hostTimer = setTimeout(() => {
      state.hostTimer = null;
      if (!state.joined || !state.room || isHostNow() || state.people.has(state.room.hostCid)) return;
      if (electionOrder()[0] === state.cid) publishState({ hostCid: state.cid });
      else scheduleHostCheck();
    }, state.hostWasSeen ? HOST_GRACE_MS : HOST_UNSEEN_MS);
  }

  /* ---------- persistence (survives reload of this tab) ---------- */
  function persist() {
    if (!state.joined) return;
    sset(SESSION_KEY, JSON.stringify({ code: state.code, cid: state.cid, me: state.me, room: state.room, savedAt: Date.now() }), "session");
  }

  /* ---------- rooms ---------- */
  function ensureNet() {
    if (Net) return true;
    showMessage("The connection library could not load. Check your internet and reload.", true);
    return false;
  }
  async function createRoom() {
    if (state.busy || !ensureNet()) return;
    try {
      const name = safeName($("hostName").value);
      const minutes = getDurationMinutes();
      const code = randomCode();
      startNet(code);
      state.me = { name, status: "studying", joinedAt: trueNow() };
      state.room = { rev: 1, hostCid: state.cid, durationMs: minutes * 60000, status: "waiting", startedAt: null, endAt: null, endedAt: null };
      sset(NAME_KEY, name, "local");
      enterRoom();
    } catch (e) { showMessage(e.message || "Unable to create room.", true); }
  }
  async function joinRoom() {
    if (state.busy || !ensureNet()) return;
    let name, code;
    try {
      name = safeName($("joinName").value);
      code = $("roomCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Enter the 6-character room code.");
    } catch (e) { showMessage(e.message, true); return; }
    setBusy(true);
    showMessage("Looking for room " + code + "…");
    startNet(code);
    state.room = null;
    let found = await new Promise(res => { state.pending = res; setTimeout(() => res(false), JOIN_TIMEOUT_MS / 2); });
    if (!found) {   // public sign-in networks are occasionally slow: reconnect once and look again
      startNet(code); state.room = null;
      found = await new Promise(res => { state.pending = res; setTimeout(() => res(false), JOIN_TIMEOUT_MS / 2); });
    }
    state.pending = null;
    setBusy(false);
    if (!found || !state.room) {
      stopNet();
      showMessage("Could not find room " + code + ". Check the code, and make sure the host still has the room open.", true);
      return;
    }
    if (state.room.status === "ended") {
      stopNet(); state.room = null;
      showMessage("This session has ended. Ask the host to create a new room.", true);
      return;
    }
    state.me = { name, status: "studying", joinedAt: trueNow() };
    sset(NAME_KEY, name, "local");
    enterRoom();
  }
  function enterRoom(resumed) {
    state.joined = true;
    state.lastHostCid = state.room.hostCid;
    state.hostWasSeen = state.people.has(state.room.hostCid) || state.room.hostCid === state.cid;
    $("entryPanel").classList.add("hidden");
    $("introPanel").classList.add("hidden");
    $("configNotice").classList.add("hidden");
    $("roomPanel").classList.remove("hidden");
    $("roomTitle").textContent = "Room " + state.code;
    try { history.replaceState(null, "", "#room=" + state.code); } catch (_) {}
    clearInterval(state.tick); clearInterval(state.beat);
    state.tick = setInterval(renderTimer, 250);
    // Gentle re-broadcast heals any message a flaky connection might have dropped.
    state.beat = setInterval(() => { sendProfile(); if (isHostNow()) sendState(); }, 20000);
    sendProfile(); if (isHostNow()) sendState();
    persist(); renderRoom(); updateConnection(); scheduleHostCheck();
    showMessage(resumed ? "Welcome back to room " + state.code + "." : (isHostNow() ? "Room " + state.code + " is ready. Share the code!" : "Joined room " + state.code + ". Welcome, " + state.me.name + "!"));
  }
  function resetToEntry() {
    clearInterval(state.tick); clearInterval(state.beat);
    state.joined = false; state.room = null; state.me = null; state.code = null; state.lastHostCid = null;
    stopNet();
    sdel(SESSION_KEY, "session");
    document.title = BASE_TITLE;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    $("roomPanel").classList.add("hidden");
    $("entryPanel").classList.remove("hidden");
    $("introPanel").classList.remove("hidden");
    updateConnection();
  }
  function tryResume() {
    let saved = null;
    try { saved = JSON.parse(sget(SESSION_KEY, "session") || "null"); } catch (_) {}
    if (!saved || saved.cid !== state.cid || !/^[A-Z0-9]{6}$/.test(saved.code || "") || !saved.me || !saved.room) return;
    if (Date.now() - saved.savedAt > 12 * 3600 * 1000 || saved.room.status === "ended") { sdel(SESSION_KEY, "session"); return; }
    startNet(saved.code);
    state.me = saved.me; state.room = saved.room;
    enterRoom(true);
  }

  /* ---------- rendering ---------- */
  function formatTime(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
  }
  function remainingMs(room) {
    if (!room) return 0;
    if (room.status === "running" && Number.isFinite(room.endAt)) return Math.max(0, room.endAt - trueNow());
    if (room.status === "ended") return 0;
    return Number(room.durationMs) || 0;
  }
  function renderTimer() {
    const room = state.room;
    if (!room || !state.joined) return;
    const host = isHostNow();
    const left = remainingMs(room);
    const text = formatTime(left);
    $("timerDisplay").textContent = text;
    const status = $("sessionStatus");
    status.className = "status-pill";
    if (room.status === "running") {
      status.textContent = left <= 0 ? "Time complete" : "In progress";
      if (left > 0) status.classList.add("running");
      $("timerCaption").textContent = left <= 0 ? "Time is up! Well done. " + (host ? "Start another round or end the session." : "The host can start another round.") : "The shared clock keeps running, even when someone is on a break.";
      document.title = (left > 0 ? text + " · " : "Done · ") + "Studgether";
    } else if (room.status === "ended") {
      status.textContent = "Ended"; status.classList.add("ended");
      $("timerCaption").textContent = "The host ended this session.";
      document.title = "Ended · Studgether";
    } else {
      status.textContent = "Not started";
      $("timerCaption").textContent = host ? "Press start when everyone is ready." : "Waiting for the host to start the shared session.";
      document.title = BASE_TITLE;
    }
    $("startBtn").disabled = room.status === "ended" || (room.status === "running" && left > 0);
    $("startBtn").textContent = room.status === "running" && left <= 0 ? "Start another round" : "Start shared timer";
    $("restartBtn").disabled = room.status === "ended" || room.status === "waiting";
    $("endBtn").disabled = room.status === "ended";
  }
  function renderRoom() {
    const room = state.room;
    if (!room || !state.joined) return;
    const host = isHostNow();
    $("hostControls").classList.toggle("hidden", !host);
    $("nonHostHint").classList.toggle("hidden", host);
    $("hostLabel").textContent = host ? "You are the host" : "Host controls the session";
    const minutes = Math.round((Number(room.durationMs) || 0) / 60000);
    $("roomMeta").textContent = minutes + " minute session · " + (room.status === "running" ? "Shared clock running" : room.status === "ended" ? "Session ended" : "Ready to start");
    renderTimer();
    renderParticipants();
  }
  function renderParticipants() {
    if (!state.joined || !state.room) return;
    const hostId = state.room.hostCid;
    const all = [[state.cid, state.me]].concat(Array.from(state.people.entries()));
    $("participantCount").textContent = String(all.length);
    all.sort((a, b) => (b[0] === hostId) - (a[0] === hostId) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    $("participantList").innerHTML = all.map(([id, p]) => {
      const name = escapeText(p.name || "Participant");
      const tags = (id === hostId ? '<span class="host-tag">HOST</span>' : "") + (id === state.cid ? '<span class="you-tag">YOU</span>' : "");
      return '<li class="participant"><div class="person"><span class="avatar">' + escapeText((p.name || "?").trim().charAt(0).toUpperCase()) + '</span><div class="person-name">' + name + tags + '</div></div><span class="person-status">' + (statusNames[p.status] || "Studying") + '</span></li>';
    }).join("");
    document.querySelectorAll(".status-choice").forEach(btn => btn.classList.toggle("active", btn.dataset.status === state.me.status));
  }

  /* ---------- actions ---------- */
  function setOwnStatus(status) {
    if (!state.joined || !statusNames[status]) return;
    state.me.status = status; sendProfile(); persist(); renderParticipants();
  }
  function startSession(isRestart) {
    const room = state.room;
    if (!isHostNow() || !room || room.status === "ended") return;
    if (!isRestart && room.status === "running" && remainingMs(room) > 0) return;
    const t = trueNow();
    publishState({ status: "running", startedAt: t, endAt: t + room.durationMs, endedAt: null });
    showMessage(isRestart ? "Shared timer restarted for everyone." : "Shared timer started.");
  }
  function restartSession() {
    if (!isHostNow() || !state.room) return;
    if (!confirm("Restart the shared timer for everyone in this room?")) return;
    startSession(true);
  }
  function endSession() {
    if (!isHostNow() || !state.room || state.room.status === "ended") return;
    if (!confirm("End this shared session for everyone? This cannot be undone.")) return;
    publishState({ status: "ended", endedAt: trueNow() });
    showMessage("Session ended.");
  }
  async function copyInvite() {
    if (!state.code) return;
    const invite = location.origin + location.pathname + "#room=" + state.code;
    const text = "Join my Studgether study room " + state.code + ": " + invite;
    try { await navigator.clipboard.writeText(text); showMessage("Invite copied. Send it to your study group."); }
    catch (_) { prompt("Copy this invite and send it to your group:", text); }
  }
  async function leaveRoom() {
    if (!state.joined) return;
    if (isHostNow() && state.people.size) {
      const next = electionOrder().filter(id => id !== state.cid)[0];
      if (next) publishState({ hostCid: next });   // instant handover
      await sleep(350);
    }
    resetToEntry();
  }

  /* ---------- wiring ---------- */
  function onHashRoom() {
    const match = location.hash.match(/room=([A-Z0-9]{6})/i);
    if (match) $("roomCode").value = match[1].toUpperCase();
  }
  $("duration").addEventListener("change", () => $("customDurationWrap").classList.toggle("hidden", $("duration").value !== "custom"));
  $("createRoomBtn").addEventListener("click", createRoom);
  $("joinRoomBtn").addEventListener("click", joinRoom);
  $("startBtn").addEventListener("click", () => startSession(false));
  $("restartBtn").addEventListener("click", restartSession);
  $("endBtn").addEventListener("click", endSession);
  $("shareBtn").addEventListener("click", copyInvite);
  $("leaveBtn").addEventListener("click", leaveRoom);
  $("roomCode").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
  [["hostName", createRoom], ["joinName", joinRoom], ["roomCode", joinRoom]].forEach(([id, fn]) => $(id).addEventListener("keydown", e => { if (e.key === "Enter") fn(); }));
  document.querySelectorAll(".status-choice").forEach(btn => btn.addEventListener("click", () => setOwnStatus(btn.dataset.status)));
  window.addEventListener("hashchange", onHashRoom);
  window.addEventListener("pagehide", () => { if (state.joined && state.net) state.net.send({ t: "b", cid: state.cid }); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.joined) { sendProfile(); if (isHostNow()) sendState(); syncClock(); } });

  state.cid = sget(CID_KEY, "session");
  if (!state.cid) { state.cid = randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789"); sset(CID_KEY, state.cid, "session"); }
  const savedName = sget(NAME_KEY, "local");
  if (savedName) { $("hostName").value = savedName; $("joinName").value = savedName; }
  onHashRoom();
  document.title = BASE_TITLE;
  if (!Net) {
    setConnection("Unavailable", "error");
    showNotice("Could not load", "Studgether's connection library did not load. Check your internet connection and reload the page.");
  } else {
    updateConnection();
    syncClock();
    setInterval(syncClock, 5 * 60 * 1000);
    tryResume();
  }
})();
