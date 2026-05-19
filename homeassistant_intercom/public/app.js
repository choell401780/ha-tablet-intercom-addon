'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const S = Object.freeze({
  IDLE: 'idle', CALLING: 'calling', RINGING: 'ringing', INCALL: 'in_call',
});

const RING_TIMEOUT_MS = 30_000;

// ─── App state ────────────────────────────────────────────────────────────────

let state              = S.IDLE;
let myStation          = null;    // station id (string, from URL param)
let myStationName      = null;    // display name
let configuredTargets  = [];      // [{id, name}] – from /api/config?station=X
let configuredRingtone = 'ring1';
let debugEnabled       = false;

let ws           = null;
let wsTimer      = null;
let localStream  = null;
let txStream     = null;
let pc           = null;
let peer         = null;
let isCaller     = false;
let muted        = false;
let camOff       = false;
let iceBuf       = [];
let ringTimer    = null;

let micGainNode  = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $  = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

const vidRemote = $('vid-remote');
const vidLocal  = $('vid-local');
const volSlider = $('vol-slider');

function setStatus(msg)  { $('statusbar').textContent  = msg; }
function setHdrSub(msg)  { $('lbl-status').textContent = msg; }
function showOverlay(t)  { $('overlay-text').textContent = t; $('overlay-call').classList.remove('hidden'); }
function hideOverlay()   { $('overlay-call').classList.add('hidden'); }

function showBusy(msg) {
  $('lbl-busy').textContent = msg;
  $('banner-busy').classList.remove('hidden');
  setTimeout(() => $('banner-busy').classList.add('hidden'), 3000);
}

// ─── Error screen ─────────────────────────────────────────────────────────────

function showError(title, message, detail = '') {
  $('err-title').textContent   = title;
  $('err-msg').textContent     = message;
  $('err-detail').innerHTML    = detail;

  // Fix the admin link to work from any sub-path (HA Ingress support)
  const adminBase = window.location.pathname.replace(/\/?(\?.*)?$/, '/');
  $('err-admin-link').href = adminBase + 'admin';

  $('screen-error').classList.add('active');
  $('screen-main').classList.remove('active');
}

// ─── Ringtone (Web Audio API synthesis) ──────────────────────────────────────

const RING_PATTERNS = {
  ring1: [[880, 0.15], [0, 0.08], [880, 0.15], [0, 0.72]],
  ring2: [[440, 0.70], [0, 0.50]],
  ring3: [[1047,0.07], [0, 0.04],[1047,0.07],[0,0.04],[1047,0.07],[0,0.58]],
  ring4: [[880, 0.18], [660, 0.18],[440, 0.36],[0, 0.38]],
  ring5: [[440, 0.18], [660, 0.18],[880, 0.36],[0, 0.38]],
};

const ring = (() => {
  let _ctx    = null;
  let _active = false;
  let _loop   = null;

  function _ac() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  function _play(pattern) {
    if (!_active) return;
    const ctx = _ac();
    const seq = RING_PATTERNS[pattern] || RING_PATTERNS.ring1;
    let   t   = ctx.currentTime + 0.01;
    let total = 0;
    seq.forEach(([freq, dur]) => {
      if (freq > 0) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.45, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.88);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur);
      }
      t     += dur;
      total += dur;
    });
    _loop = setTimeout(() => _play(pattern), total * 1000);
  }

  return {
    start(pattern) {
      if (_active) return;
      _active = true;
      _play(pattern || 'ring1');
    },
    stop() {
      _active = false;
      if (_loop) { clearTimeout(_loop); _loop = null; }
    },
    unlock() { try { _ac(); } catch { /* ignored */ } },
  };
})();

document.addEventListener('click',      () => ring.unlock(), { once: true });
document.addEventListener('touchstart', () => ring.unlock(), { once: true });

// ─── Ring timeout ─────────────────────────────────────────────────────────────

function startRingTimeout() {
  clearRingTimeout();
  ringTimer = setTimeout(() => {
    dbg('Klingelton-Timeout – Anruf abgewiesen');
    dismissIncoming();
    if (peer) send({ type: 'call-rejected', to: peer });
    peer = null;
    setState(S.IDLE);
    setStatus('Keine Antwort');
  }, RING_TIMEOUT_MS);
}

function clearRingTimeout() {
  if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
}

function dismissIncoming() {
  ring.stop();
  clearRingTimeout();
  $('banner-incoming').classList.add('hidden');
}

// ─── Volume ───────────────────────────────────────────────────────────────────

function applyVolume(val) {
  vidRemote.volume = Math.max(0, Math.min(1, val / 100));
}

// ─── Config loading ───────────────────────────────────────────────────────────

async function loadConfig(stationId) {
  const r = await fetch(`api/config?station=${encodeURIComponent(stationId)}`);
  if (r.status === 404) {
    const body = await r.json().catch(() => ({}));
    const avail = (body.available || []).join(', ') || '–';
    showError(
      'Unbekannte Station',
      `Die Station "${stationId}" ist nicht im Add-on konfiguriert.`,
      `<p>Konfigurierte Stationen: <strong>${avail}</strong></p>` +
      `<p>Bitte den Link korrigieren oder die Add-on-Konfiguration prüfen.</p>`
    );
    return null;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  // Station MUST be provided via URL parameter – no fallback to localStorage or config defaults.
  // This is intentional: each tablet gets its own permanent link that defines its identity.
  const urlStation = new URLSearchParams(window.location.search).get('station');

  if (!urlStation) {
    const basePath = window.location.pathname.replace(/\/?(\?.*)?$/, '/');
    showError(
      'Kein Stationslink verwendet',
      'Dieses Tablet hat keinen Stationsparameter in der URL.',
      `<p>Füge <code>?station=<em>id</em></code> zur URL hinzu, z. B.:</p>` +
      `<pre>${window.location.origin}${basePath}?station=buero</pre>` +
      `<p>Die fertigen Stationslinks findest du in der Stationsverwaltung.</p>`
    );
    return;
  }

  let cfg;
  try {
    cfg = await loadConfig(urlStation);
  } catch (e) {
    showError('Verbindungsfehler', `Konfiguration konnte nicht geladen werden: ${e.message}`);
    return;
  }
  if (!cfg) return; // error already shown

  myStation     = cfg.station.id;
  myStationName = cfg.station.name;

  configuredRingtone = cfg.station.ringtone ?? 'ring1';
  configuredTargets  = cfg.targets ?? [];
  debugEnabled       = cfg.debug === true;

  // Volume: config default, allow per-session override via slider
  const sessVol = localStorage.getItem('intercom-vol-session');
  const initVol = sessVol !== null ? parseInt(sessVol, 10) : (cfg.station.speaker_volume ?? 80);
  volSlider.value = initVol;
  applyVolume(initVol);

  $('lbl-station').textContent = myStationName;
  renderStations([]);
  setState(S.IDLE);

  // Hauptscreen einblenden – beide .screen-Divs starten mit display:none
  $('screen-main').classList.add('active');
  $('screen-error').classList.remove('active');

  if (debugEnabled) $('debug-panel').classList.remove('hidden');
  setStatus('Kamera wird gestartet…');

  dbg(`Station: ${myStation} (${myStationName})`);
  dbg(`Ziele: ${configuredTargets.map((t) => t.id).join(', ') || '–'}`);
  dbg(`Klingelton: ${configuredRingtone} | Lautstärke: ${initVol}% | Gain: ${cfg.station.microphone_gain}%`);

  await initMedia(cfg.station.microphone_gain ?? 100);
  openWs();
})();

// ─── Volume slider ────────────────────────────────────────────────────────────

volSlider.addEventListener('input', () => {
  const v = parseInt(volSlider.value, 10);
  applyVolume(v);
  localStorage.setItem('intercom-vol-session', v);
});

// ─── Media init ───────────────────────────────────────────────────────────────

async function initMedia(micGainPct) {
  const tries = [
    { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
    { video: true,  audio: true  },
    { video: false, audio: true  },
  ];

  for (const c of tries) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(c);
      vidLocal.srcObject = localStream;
      dbg(`Media OK – video:${localStream.getVideoTracks().length > 0} audio:${localStream.getAudioTracks().length > 0}`);
      txStream = await setupMicGain(localStream, micGainPct);
      return;
    } catch (e) {
      dbg(`getUserMedia: ${e.message}`, 'warn');
    }
  }
  setStatus('⚠️ Kamera/Mikrofon nicht verfügbar – Nur-Audio-Empfang möglich');
  dbg('Kein Mediengerät verfügbar – UI bleibt aktiv', 'warn');
}

// ─── Mic Gain (Web Audio API) ─────────────────────────────────────────────────

async function setupMicGain(stream, gainPct = 100) {
  if (!stream?.getAudioTracks().length) return stream;
  try {
    const ctx   = new (window.AudioContext || window.webkitAudioContext)();
    const src   = ctx.createMediaStreamSource(stream);
    micGainNode = ctx.createGain();
    micGainNode.gain.value = gainPct / 100;
    const dst   = ctx.createMediaStreamDestination();
    src.connect(micGainNode);
    micGainNode.connect(dst);
    dbg(`Mic Gain: ${(gainPct / 100).toFixed(2)}`);
    return new MediaStream([
      ...stream.getVideoTracks(),
      ...dst.stream.getAudioTracks(),
    ]);
  } catch (e) {
    dbg(`Mic-Gain-Setup übersprungen: ${e.message}`, 'warn');
    return stream;
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function openWs() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }

  const loc      = window.location;
  const prot     = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = loc.pathname.replace(/\/$/, '');
  const url      = `${prot}//${loc.host}${basePath}/ws`;

  dbg(`href:     ${loc.href}`);
  dbg(`basePath: ${basePath || '/'}`);
  dbg(`WS URL:   ${url}`);
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
    ws.send(JSON.stringify({ type: 'register', station: myStation, name: myStationName }));
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
  dbg(`← ${m.type}${m.from ? ' / ' + m.from : ''}`, 'recv');

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
      peer     = m.from;
      isCaller = false;
      setState(S.RINGING);
      $('lbl-caller').textContent = nameOf(m.from);
      $('banner-incoming').classList.remove('hidden');
      setStatus(`Eingehender Anruf von ${nameOf(m.from)}`);
      ring.start(configuredRingtone);
      startRingTimeout();
      break;

    case 'call-accepted':
      if (state !== S.CALLING) return;
      peer = m.from;
      setState(S.INCALL);
      hideOverlay();
      showControls();
      setStatus(`Verbinde mit ${nameOf(peer)}…`);
      await startAsCaller();
      break;

    case 'call-rejected':
      if (state === S.CALLING) {
        setState(S.IDLE); hideOverlay(); peer = null;
        setStatus(`${nameOf(m.from)} hat abgelehnt`);
      }
      break;

    case 'busy':
      setState(S.IDLE); hideOverlay(); peer = null;
      showBusy(`${nameOf(m.from)} ist besetzt`);
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
      dismissIncoming();
      setStatus(`${nameOf(m.from)} hat aufgelegt`);
      hangup(false);
      break;

    case 'replaced':
      dbg('Station von anderer Verbindung übernommen', 'warn');
      break;

    case 'error':
      setStatus(`Fehler: ${m.message}`);
      dbg(`Server: ${m.message}`, 'error');
      if (state === S.CALLING || state === S.RINGING) {
        dismissIncoming(); setState(S.IDLE); hideOverlay(); peer = null;
      }
      break;
  }
}

// ─── Station list ─────────────────────────────────────────────────────────────

function renderStations(liveList) {
  const el     = $('station-list');
  el.innerHTML = '';

  if (configuredTargets.length === 0) {
    el.innerHTML = '<span class="no-stations">Keine weiteren Stationen konfiguriert</span>';
    return;
  }

  const liveMap = new Map(liveList.map((s) => [s.id, s]));

  configuredTargets.forEach((target) => {
    const btn = document.createElement('button');
    btn.dataset.id = target.id;

    if (target.id === 'all') {
      const anyAvail = [...liveMap.values()].some((s) => !s.inCall);
      btn.className = 'btn-call btn-call-all' + (!anyAvail ? ' is-offline' : '');
      btn.disabled  = state !== S.IDLE || !anyAvail;
      btn.innerHTML = `<span>📣</span><span>${target.name}</span>`;
      if (anyAvail) btn.addEventListener('click', () => call('all'));
    } else {
      const live     = liveMap.get(target.id);
      const isOnline = !!live;
      const isBusy   = live?.inCall === true;
      btn.className  = 'btn-call' + (!isOnline ? ' is-offline' : isBusy ? ' is-busy' : '');
      btn.disabled   = state !== S.IDLE || !isOnline;
      const icon = !isOnline ? '⚫' : isBusy ? '🔴' : '📞';
      btn.innerHTML  = `<span>${icon}</span><span>${target.name}</span>`;
      if (isOnline) btn.addEventListener('click', () => call(target.id));
    }

    el.appendChild(btn);
  });
}

function nameOf(id) {
  if (id === 'all') return 'Alle';
  return configuredTargets.find((t) => t.id === id)?.name ?? id;
}

// ─── Outgoing call ────────────────────────────────────────────────────────────

function call(targetId) {
  if (state !== S.IDLE) return;
  peer     = targetId;
  isCaller = true;
  setState(S.CALLING);
  showOverlay(`Rufe ${nameOf(targetId)} an…`);
  setStatus(`Wähle ${nameOf(targetId)}…`);
  send({ type: 'call-request', to: targetId });
}

// ─── Accept / Reject ──────────────────────────────────────────────────────────

on('btn-accept', 'click', () => {
  dismissIncoming();
  send({ type: 'call-accepted', to: peer });
  setState(S.INCALL);
  showControls();
  setStatus(`Gespräch mit ${nameOf(peer)} aktiv`);
});

on('btn-reject', 'click', () => {
  dismissIncoming();
  send({ type: 'call-rejected', to: peer });
  peer = null;
  setState(S.IDLE);
  setStatus('Anruf abgelehnt');
});

// ─── WebRTC – Caller ──────────────────────────────────────────────────────────

async function startAsCaller() {
  pc = makePc();
  const stream = txStream || localStream;
  if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  send({ type: 'offer', to: peer, sdp: pc.localDescription });
  dbg('Offer gesendet');
}

// ─── WebRTC – Callee ──────────────────────────────────────────────────────────

async function onOffer(m) {
  pc = makePc();
  const stream = txStream || localStream;
  if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));
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
  await flushIceBuf();
  dbg('Remote SDP gesetzt');
}

async function onIce(m) {
  if (!m.candidate) return;
  if (!pc?.remoteDescription) { iceBuf.push(m.candidate); return; }
  try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate)); }
  catch (e) { dbg(`ICE: ${e.message}`, 'warn'); }
}

async function flushIceBuf() {
  while (iceBuf.length) {
    try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); }
    catch { /* stale */ }
  }
}

// ─── PeerConnection factory ───────────────────────────────────────────────────

function makePc() {
  const conn = new RTCPeerConnection(ICE);

  conn.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'ice-candidate', to: peer, candidate });
  };

  conn.ontrack = ({ streams }) => {
    dbg('Remote Track empfangen');
    if (vidRemote.srcObject !== streams[0]) {
      vidRemote.srcObject = streams[0];
      vidRemote.volume    = parseInt(volSlider.value, 10) / 100;
      $('vid-placeholder').classList.add('hidden');
    }
  };

  conn.oniceconnectionstatechange = () => {
    dbg(`ICE: ${conn.iceConnectionState}`);
    if (conn.iceConnectionState === 'connected' || conn.iceConnectionState === 'completed') {
      setStatus(`Verbunden mit ${nameOf(peer)}`);
      setHdrSub(`Gespräch: ${nameOf(peer)}`);
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
  dismissIncoming();
  if (pc) { pc.close(); pc = null; }
  iceBuf = [];
  vidRemote.srcObject = null;
  $('vid-placeholder').classList.remove('hidden');
  $('panel-controls').classList.add('hidden');
  hideOverlay();
  peer = null; isCaller = false; muted = false; camOff = false;
  syncMuteBtn(); syncCamBtn();
  setState(S.IDLE);
  setStatus('Online – bereit');
  setHdrSub('Online');
}

// ─── Mute / Camera ────────────────────────────────────────────────────────────

function showControls() { $('panel-controls').classList.remove('hidden'); }

on('btn-mute', 'click', () => {
  muted = !muted;
  localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  if (txStream && txStream !== localStream) txStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
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
  b.querySelector('.cl').textContent = muted ? 'Ton an'   : 'Stumm';
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
    b.disabled = state !== S.IDLE || b.classList.contains('is-offline');
  });
}

// ─── Debug ────────────────────────────────────────────────────────────────────

on('btn-dbg-clear', 'click', () => { $('dbg-log').innerHTML = ''; });

function dbg(msg, level = 'info') {
  (level === 'error' ? console.error : console.log)(`[InterCom] ${msg}`);
  if (!debugEnabled) return;
  const t   = new Date().toLocaleTimeString('de-DE');
  const div = document.createElement('div');
  div.className   = `dl dl-${level}`;
  div.textContent = `[${t}] ${msg}`;
  const log = $('dbg-log');
  log.insertBefore(div, log.firstChild);
  while (log.children.length > 100) log.removeChild(log.lastChild);
}
