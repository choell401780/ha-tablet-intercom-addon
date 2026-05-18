'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const LABELS = { buero: 'Büro', flur: 'Flur', werkstatt: 'Werkstatt' };
const label  = (id) => LABELS[id] ?? id;

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const S = Object.freeze({
  SETUP: 'setup', IDLE: 'idle', CALLING: 'calling', RINGING: 'ringing', INCALL: 'in_call',
});

const RING_TIMEOUT_MS = 30_000;

// ─── App state ────────────────────────────────────────────────────────────────

let state        = S.SETUP;
let myStation    = null;
let ws           = null;
let wsTimer      = null;
let localStream  = null;   // raw stream from getUserMedia (used for local preview)
let txStream     = null;   // stream sent over WebRTC (may have processed audio)
let pc           = null;   // RTCPeerConnection
let peer         = null;
let isCaller     = false;
let muted        = false;
let camOff       = false;
let iceBuf       = [];
let ringTimer    = null;   // auto-reject timeout while ringing

// Web Audio API for mic gain
let audioCtx     = null;
let micGainNode  = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $  = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

const screenSetup = $('screen-setup');
const screenMain  = $('screen-main');
const vidRemote   = $('vid-remote');
const vidLocal    = $('vid-local');

function showScreen(name) {
  screenSetup.classList.toggle('active', name === 'setup');
  screenMain.classList.toggle('active', name === 'main');
}

function setStatus(msg)  { $('statusbar').textContent    = msg; }
function setHdrSub(msg)  { $('lbl-status').textContent   = msg; }
function showOverlay(t)  { $('overlay-text').textContent = t; $('overlay-call').classList.remove('hidden'); }
function hideOverlay()   { $('overlay-call').classList.add('hidden'); }

function showBusy(msg) {
  $('lbl-busy').textContent = msg;
  $('banner-busy').classList.remove('hidden');
  setTimeout(() => $('banner-busy').classList.add('hidden'), 3000);
}

// ─── Ringtone (Web Audio API synthesis) ──────────────────────────────────────

// Each pattern: array of [frequency_hz, duration_s] — 0 Hz = silence
const RING_PATTERNS = {
  ring1: [[880, 0.15], [0, 0.08], [880, 0.15], [0, 0.72]],   // Doppelton klassisch
  ring2: [[440, 0.70], [0, 0.50]],                             // Einzelton lang
  ring3: [[1047, 0.07],[0, 0.04],[1047, 0.07],[0, 0.04],[1047, 0.07],[0, 0.58]], // Dreifach
  ring4: [[880, 0.18],[660, 0.18],[440, 0.36],[0, 0.38]],      // Absteigend
  ring5: [[440, 0.18],[660, 0.18],[880, 0.36],[0, 0.38]],      // Aufsteigend
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
    let t     = ctx.currentTime + 0.01;
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
      _play(pattern || selectedRing());
    },
    stop() {
      _active = false;
      if (_loop) { clearTimeout(_loop); _loop = null; }
    },
    test(pattern) {
      const ctx = _ac();
      const seq = RING_PATTERNS[pattern] || RING_PATTERNS.ring1;
      let t = ctx.currentTime + 0.01;
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
        t += dur;
      });
    },
    // Pre-warm AudioContext after first user gesture
    unlock() { _ac(); },
  };
})();

// Unlock AudioContext on first user interaction (required by Chrome autoplay policy)
document.addEventListener('click',      () => ring.unlock(), { once: true });
document.addEventListener('touchstart', () => ring.unlock(), { once: true });

// ─── Ring selection helper ────────────────────────────────────────────────────

function selectedRing() {
  return localStorage.getItem('intercom-ring') || 'ring1';
}

// ─── Ringtone timeout helpers ─────────────────────────────────────────────────

function startRingTimeout() {
  clearRingTimeout();
  ringTimer = setTimeout(() => {
    dbg('Klingelton-Timeout – Anruf automatisch abgelehnt');
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

// ─── Volume helpers ───────────────────────────────────────────────────────────

function applyVolume(val) {
  vidRemote.volume = Math.max(0, Math.min(1, val / 100));
}

function savedVolume() {
  return parseInt(localStorage.getItem('intercom-vol') ?? '70', 10);
}

// ─── Setup screen ─────────────────────────────────────────────────────────────

document.querySelectorAll('.btn-pick').forEach((btn) => {
  btn.addEventListener('click', () => {
    ring.unlock();
    myStation = btn.dataset.id;
    localStorage.setItem('intercom-station', myStation);
    boot();
  });
});

on('btn-change', 'click', () => {
  localStorage.removeItem('intercom-station');
  location.reload();
});

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
  initSettings();
  await initMedia();
  openWs();
}

// ─── Media init ───────────────────────────────────────────────────────────────

async function initMedia() {
  const tries = [
    { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
    { video: true,  audio: true  },
    { video: false, audio: true  },
  ];

  for (const c of tries) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(c);
      vidLocal.srcObject = localStream;
      const v = localStream.getVideoTracks().length > 0;
      const a = localStream.getAudioTracks().length > 0;
      dbg(`Media OK – video:${v} audio:${a}`);
      txStream = await setupMicGain(localStream);
      return;
    } catch (e) {
      dbg(`getUserMedia fehlgeschlagen: ${e.message}`, 'warn');
    }
  }
  setStatus('⚠️ Kamera/Mikrofon nicht verfügbar');
  dbg('Kein Mediengerät verfügbar', 'error');
}

// ─── Mic Gain (Web Audio API) ─────────────────────────────────────────────────

async function setupMicGain(stream) {
  if (!stream?.getAudioTracks().length) return stream;
  try {
    audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
    const src   = audioCtx.createMediaStreamSource(stream);
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = savedGain() / 100;
    const dst   = audioCtx.createMediaStreamDestination();
    src.connect(micGainNode);
    micGainNode.connect(dst);
    dbg(`Mic Gain: ${micGainNode.gain.value.toFixed(2)}`);
    return new MediaStream([
      ...stream.getVideoTracks(),
      ...dst.stream.getAudioTracks(),
    ]);
  } catch (e) {
    dbg(`Mic-Gain-Setup übersprungen: ${e.message}`, 'warn');
    return stream;
  }
}

function savedGain() {
  return parseInt(localStorage.getItem('intercom-mic-gain') ?? '100', 10);
}

function applyGain(val) {
  if (micGainNode) micGainNode.gain.value = val / 100;
  localStorage.setItem('intercom-mic-gain', val);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function openWs() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }

  const loc      = window.location;
  const prot     = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = loc.pathname.replace(/\/$/, '');
  const url      = `${prot}//${loc.host}${basePath}/ws`;

  dbg(`href:     ${loc.href}`);
  dbg(`pathname: ${loc.pathname}`);
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
      ring.start();
      startRingTimeout();
      break;

    case 'call-accepted':
      if (state !== S.CALLING) return;
      peer = m.from;
      setState(S.INCALL);
      $('banner-incoming').classList.add('hidden');
      hideOverlay();
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
      // Stop ring in case caller hung up while callee was still ringing
      dismissIncoming();
      setStatus(`${label(m.from)} hat aufgelegt`);
      hangup(false);
      break;

    case 'replaced':
      dbg('Station von anderer Verbindung übernommen', 'warn');
      break;

    case 'error':
      setStatus(`Fehler: ${m.message}`);
      dbg(`Server: ${m.message}`, 'error');
      if (state === S.CALLING || state === S.RINGING) {
        dismissIncoming();
        setState(S.IDLE); hideOverlay(); peer = null;
      }
      break;
  }
}

// ─── Station list ─────────────────────────────────────────────────────────────

function renderStations(list) {
  const el     = $('station-list');
  el.innerHTML = '';
  const others = list.filter((s) => s.id !== myStation);

  if (others.length === 0) {
    el.innerHTML = '<span class="no-stations">Keine anderen Stationen online</span>';
    return;
  }

  others.forEach((s) => {
    const btn = document.createElement('button');
    btn.className  = 'btn-call' + (s.inCall ? ' is-busy' : '');
    btn.disabled   = (state !== S.IDLE);
    btn.dataset.id = s.id;
    btn.innerHTML  = `<span>${s.inCall ? '🔴' : '📞'}</span><span>${s.name}</span>`;
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

// ─── Accept / Reject ──────────────────────────────────────────────────────────

on('btn-accept', 'click', () => {
  dismissIncoming();
  send({ type: 'call-accepted', to: peer });
  setState(S.INCALL);
  showControls();
  setStatus(`Gespräch mit ${label(peer)} aktiv`);
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
  dbg('Remote SDP gesetzt');
  await flushIceBuf();
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
      vidRemote.volume    = savedVolume() / 100;
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

// ─── Call controls ────────────────────────────────────────────────────────────

function showControls() { $('panel-controls').classList.remove('hidden'); }

on('btn-mute', 'click', () => {
  muted = !muted;
  // Mute raw localStream audio tracks so the toggle always works regardless of gain pipeline
  localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  // Also mute the gain-processed stream tracks if present
  if (txStream && txStream !== localStream) {
    txStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }
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
  b.querySelector('.cl').textContent = muted ? 'Ton an'  : 'Stumm';
  b.classList.toggle('ctrl-active', muted);
}

function syncCamBtn() {
  const b = $('btn-cam');
  b.querySelector('.ci').textContent = camOff ? '🚫' : '📷';
  b.querySelector('.cl').textContent = camOff ? 'Kamera an' : 'Kamera aus';
  b.classList.toggle('ctrl-active', camOff);
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function initSettings() {
  // Ring selection
  const savedR = selectedRing();
  document.querySelectorAll('input[name="ringtone"]').forEach((radio) => {
    radio.checked = (radio.value === savedR);
    radio.addEventListener('change', () => {
      localStorage.setItem('intercom-ring', radio.value);
    });
  });

  // Ring test button
  on('btn-ring-test', 'click', () => ring.test(selectedRing()));

  // Volume slider
  const volSlider = $('vol-slider');
  const volPct    = $('vol-pct');
  volSlider.value = savedVolume();
  volPct.textContent = `${volSlider.value}%`;
  applyVolume(parseInt(volSlider.value, 10));

  volSlider.addEventListener('input', () => {
    const v = parseInt(volSlider.value, 10);
    volPct.textContent = `${v}%`;
    applyVolume(v);
    localStorage.setItem('intercom-vol', v);
  });

  // Gain slider
  const gainSlider = $('gain-slider');
  const gainPct    = $('gain-pct');
  gainSlider.value = savedGain();
  gainPct.textContent = `${gainSlider.value}%`;

  gainSlider.addEventListener('input', () => {
    const v = parseInt(gainSlider.value, 10);
    gainPct.textContent = `${v}%`;
    applyGain(v);
    dbg(`Mic Gain: ${(v / 100).toFixed(2)}`);
  });

  // Settings toggle
  on('btn-settings-toggle', 'click', () => {
    const p = $('panel-settings');
    p.classList.toggle('hidden');
    $('btn-settings-toggle').classList.toggle('foot-active', !p.classList.contains('hidden'));
  });
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
  (level === 'error' ? console.error : console.log)(`[InterCom] ${msg}`);
}
