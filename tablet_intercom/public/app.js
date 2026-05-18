'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const LABELS = { buero: 'Büro', flur: 'Flur', werkstatt: 'Werkstatt' };
const label  = (id) => LABELS[id] ?? id;

const ICE = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// States
const S = Object.freeze({
  SETUP:   'setup',
  IDLE:    'idle',
  CALLING: 'calling',
  RINGING: 'ringing',
  INCALL:  'in_call',
});

// ─── App state ────────────────────────────────────────────────────────────────
let state       = S.SETUP;
let myStation   = null;
let ws          = null;
let wsTimer     = null;
let pc          = null;          // RTCPeerConnection
let localStream = null;
let peer        = null;          // partner station id
let isCaller    = false;
let muted       = false;
let camOff      = false;
let iceBuf      = [];            // candidates buffered before remote desc

// ─── DOM helpers ─────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

const screenSetup = $('screen-setup');
const screenMain  = $('screen-main');

function showScreen(name) {
  screenSetup.classList.toggle('active', name === 'setup');
  screenMain.classList.toggle('active', name === 'main');
}

function setStatus(msg) { $('statusbar').textContent = msg; }
function setHdrSub(msg) { $('lbl-status').textContent = msg; }

function showOverlay(txt) {
  $('overlay-text').textContent = txt;
  $('overlay-call').classList.remove('hidden');
}
function hideOverlay() { $('overlay-call').classList.add('hidden'); }

function showBusy(msg) {
  $('lbl-busy').textContent = msg;
  $('banner-busy').classList.remove('hidden');
  setTimeout(() => $('banner-busy').classList.add('hidden'), 3000);
}

// ─── Station selection ────────────────────────────────────────────────────────
document.querySelectorAll('.btn-pick').forEach((btn) => {
  btn.addEventListener('click', () => {
    myStation = btn.dataset.id;
    localStorage.setItem('intercom-station', myStation);
    boot();
  });
});

on('btn-change', 'click', () => {
  localStorage.removeItem('intercom-station');
  location.reload();
});

// Auto-boot if station is saved
const saved = localStorage.getItem('intercom-station');
if (saved) {
  myStation = saved;
  boot();
} else {
  showScreen('setup');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  showScreen('main');
  $('lbl-station').textContent = label(myStation);
  setState(S.IDLE);
  setStatus('Kamera wird gestartet…');
  await initMedia();
  openWs();
}

async function initMedia() {
  // Try progressively simpler constraints
  const tries = [
    { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
    { video: true, audio: true },
    { video: false, audio: true },
  ];
  for (const c of tries) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(c);
      $('vid-local').srcObject = localStream;
      const v = localStream.getVideoTracks().length > 0;
      const a = localStream.getAudioTracks().length > 0;
      dbg(`Media OK – video:${v} audio:${a}`);
      return;
    } catch (e) {
      dbg(`getUserMedia fehlgeschlagen: ${e.message}`, 'warn');
    }
  }
  setStatus('⚠️ Kamera/Mikrofon nicht verfügbar – Berechtigungen prüfen');
  dbg('Kein Mediengerät verfügbar', 'error');
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function openWs() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }

  // Build WS URL from current page location.
  // Works for direct access (ws://host:8099) and HA Ingress (wss://ha/api/hassio_ingress/TOKEN/).
  const loc  = window.location;
  const prot = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // Keep pathname for Ingress; strip trailing slash then re-add nothing
  const path = loc.pathname === '/' ? '' : loc.pathname.replace(/\/$/, '');
  const url  = `${prot}//${loc.host}${path}`;

  dbg(`WS → ${url}`);
  setStatus('Verbinde…');

  try {
    ws = new WebSocket(url);
  } catch (e) {
    dbg(`WS Fehler: ${e.message}`, 'error');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    $('dot-ws').className = 'dot dot-on';
    dbg('WS verbunden');
    ws.send(JSON.stringify({ type: 'register', station: myStation }));
  };

  ws.onclose = () => {
    $('dot-ws').className = 'dot dot-off';
    setHdrSub('Offline');
    dbg('WS getrennt');
    scheduleReconnect();
  };

  ws.onerror = () => dbg('WS Verbindungsfehler', 'error');

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onSignal(m);
  };
}

function scheduleReconnect() {
  if (wsTimer) return;
  wsTimer = setTimeout(() => { wsTimer = null; openWs(); }, 3000);
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ─── Signaling ────────────────────────────────────────────────────────────────
async function onSignal(m) {
  dbg(`← ${m.type}${m.from ? ' / ' + label(m.from) : ''}`, 'recv');

  switch (m.type) {

    case 'registered':
      setStatus('Online – bereit');
      setHdrSub('Online');
      break;

    case 'stations':
      renderStations(m.stations);
      break;

    case 'call-request':
      if (state !== S.IDLE) { send({ type: 'busy', to: m.from }); return; }
      peer    = m.from;
      isCaller = false;
      setState(S.RINGING);
      $('lbl-caller').textContent = label(m.from);
      $('banner-incoming').classList.remove('hidden');
      setStatus(`Eingehender Anruf von ${label(m.from)}`);
      break;

    case 'call-accepted':
      if (state !== S.CALLING) return;
      peer = m.from;
      setState(S.INCALL);
      $('banner-incoming').classList.add('hidden');
      showControls();
      setStatus(`Verbinde mit ${label(peer)}…`);
      await startAsCaller();
      break;

    case 'call-rejected':
      if (state === S.CALLING) {
        setState(S.IDLE);
        setStatus(`${label(m.from)} hat abgelehnt`);
        hideOverlay();
        peer = null;
      }
      break;

    case 'busy':
      setState(S.IDLE);
      showBusy(`${label(m.from)} ist besetzt`);
      hideOverlay();
      peer = null;
      break;

    case 'offer':
      if (state === S.INCALL) await onOffer(m);
      break;

    case 'answer':
      await onAnswer(m);
      break;

    case 'ice-candidate':
      await onIce(m);
      break;

    case 'call-ended':
      setStatus(`${label(m.from)} hat aufgelegt`);
      hangup(false);
      break;

    case 'replaced':
      dbg('Diese Station wurde von einer anderen Verbindung übernommen', 'warn');
      break;

    case 'error':
      setStatus(`Fehler: ${m.message}`);
      dbg(`Server-Fehler: ${m.message}`, 'error');
      if (state === S.CALLING || state === S.RINGING) {
        setState(S.IDLE); hideOverlay(); peer = null;
      }
      break;
  }
}

// ─── Station list ─────────────────────────────────────────────────────────────
function renderStations(list) {
  const el   = $('station-list');
  el.innerHTML = '';
  const others = list.filter((s) => s.id !== myStation);

  if (others.length === 0) {
    el.innerHTML = '<span class="no-stations">Keine anderen Stationen online</span>';
    return;
  }

  others.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'btn-call' + (s.inCall ? ' is-busy' : '');
    btn.disabled  = (state !== S.IDLE);
    btn.dataset.id = s.id;
    btn.innerHTML = `<span>${s.inCall ? '🔴' : '📞'}</span><span>${s.name}</span>`;
    btn.addEventListener('click', () => call(s.id));
    el.appendChild(btn);
  });
}

// ─── Outgoing call ────────────────────────────────────────────────────────────
function call(targetId) {
  if (state !== S.IDLE) return;
  peer     = targetId;
  isCaller = true;
  setState(S.CALLING);
  showOverlay(`Rufe ${label(targetId)} an…`);
  setStatus(`Wähle ${label(targetId)}…`);
  send({ type: 'call-request', to: targetId });
}

// ─── Accept / Reject ─────────────────────────────────────────────────────────
on('btn-accept', 'click', () => {
  $('banner-incoming').classList.add('hidden');
  send({ type: 'call-accepted', to: peer });
  setState(S.INCALL);
  showControls();
  setStatus(`Gespräch mit ${label(peer)} aktiv`);
});

on('btn-reject', 'click', () => {
  $('banner-incoming').classList.add('hidden');
  send({ type: 'call-rejected', to: peer });
  peer = null;
  setState(S.IDLE);
  setStatus('Anruf abgelehnt');
});

// ─── WebRTC – Caller side ─────────────────────────────────────────────────────
async function startAsCaller() {
  pc = makePc();
  localStream?.getTracks().forEach((t) => pc.addTrack(t, localStream));

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  send({ type: 'offer', to: peer, sdp: pc.localDescription });
  dbg('Offer gesendet');
}

// ─── WebRTC – Callee side ─────────────────────────────────────────────────────
async function onOffer(m) {
  pc = makePc();
  localStream?.getTracks().forEach((t) => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
  await flushIceBuf();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', to: m.from, sdp: pc.localDescription });
  dbg('Answer gesendet');
}

async function onAnswer(m) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
  dbg('Remote SDP gesetzt');
  await flushIceBuf();
}

async function onIce(m) {
  if (!m.candidate) return;
  if (!pc?.remoteDescription) { iceBuf.push(m.candidate); return; }
  try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); }
  catch (e) { dbg(`ICE addCandidate: ${e.message}`, 'warn'); }
}

async function flushIceBuf() {
  while (iceBuf.length) {
    try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); }
    catch { /* stale candidate */ }
  }
}

// ─── RTCPeerConnection factory ────────────────────────────────────────────────
function makePc() {
  const conn = new RTCPeerConnection(ICE);

  conn.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'ice-candidate', to: peer, candidate });
  };

  conn.ontrack = ({ streams }) => {
    dbg(`Remote Track empfangen`);
    if ($('vid-remote').srcObject !== streams[0]) {
      $('vid-remote').srcObject = streams[0];
      $('vid-placeholder').classList.add('hidden');
    }
  };

  conn.oniceconnectionstatechange = () => {
    dbg(`ICE: ${conn.iceConnectionState}`);
    if (conn.iceConnectionState === 'connected' || conn.iceConnectionState === 'completed') {
      setStatus(`Verbunden mit ${label(peer)}`);
      setHdrSub(`Gespräch: ${label(peer)}`);
      hideOverlay();
    } else if (conn.iceConnectionState === 'failed') {
      setStatus('Verbindung fehlgeschlagen');
      hangup(true);
    } else if (conn.iceConnectionState === 'disconnected') {
      setStatus('Verbindung unterbrochen…');
    }
  };

  conn.onconnectionstatechange = () => dbg(`PC: ${conn.connectionState}`);
  return conn;
}

// ─── Hang up ──────────────────────────────────────────────────────────────────
on('btn-hangup', 'click', () => hangup(true));

function hangup(notify) {
  if (notify && peer) send({ type: 'call-ended', to: peer });

  if (pc) { pc.close(); pc = null; }
  iceBuf = [];

  $('vid-remote').srcObject = null;
  $('vid-placeholder').classList.remove('hidden');
  $('panel-controls').classList.add('hidden');
  $('banner-incoming').classList.add('hidden');
  hideOverlay();

  peer = null; isCaller = false; muted = false; camOff = false;
  syncMuteBtn(); syncCamBtn();

  setState(S.IDLE);
  setStatus('Online – bereit');
  setHdrSub('Online');
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function showControls() { $('panel-controls').classList.remove('hidden'); }

on('btn-mute', 'click', () => {
  muted = !muted;
  localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  syncMuteBtn();
  dbg(`Mikrofon: ${muted ? 'stumm' : 'aktiv'}`);
});

on('btn-cam', 'click', () => {
  camOff = !camOff;
  localStream?.getVideoTracks().forEach((t) => (t.enabled = !camOff));
  syncCamBtn();
  dbg(`Kamera: ${camOff ? 'aus' : 'an'}`);
});

function syncMuteBtn() {
  const b = $('btn-mute');
  b.querySelector('.ci').textContent = muted ? '🔇' : '🎤';
  b.querySelector('.cl').textContent = muted ? 'Ton an' : 'Stumm';
  b.classList.toggle('ctrl-active', muted);
}

function syncCamBtn() {
  const b = $('btn-cam');
  b.querySelector('.ci').textContent = camOff ? '🚫' : '📷';
  b.querySelector('.cl').textContent = camOff ? 'Kamera an' : 'Kamera aus';
  b.classList.toggle('ctrl-active', camOff);
}

// ─── State machine ────────────────────────────────────────────────────────────
function setState(next) {
  state = next;
  dbg(`State → ${next}`);
  document.querySelectorAll('.btn-call').forEach((b) => {
    b.disabled = (next !== S.IDLE);
  });
}

// ─── Debug ────────────────────────────────────────────────────────────────────
on('btn-dbg-toggle', 'click', () => $('debug-panel').classList.toggle('hidden'));
on('btn-dbg-clear',  'click', () => { $('dbg-log').innerHTML = ''; });

function dbg(msg, level = 'info') {
  const t   = new Date().toLocaleTimeString('de-DE');
  const div = document.createElement('div');
  div.className   = `dl dl-${level}`;
  div.textContent = `[${t}] ${msg}`;
  const log = $('dbg-log');
  log.insertBefore(div, log.firstChild);
  while (log.children.length > 100) log.removeChild(log.lastChild);
  (level === 'error' ? console.error : console.log)(`[Intercom] ${msg}`);
}
