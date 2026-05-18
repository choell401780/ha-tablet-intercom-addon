'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const PORT         = parseInt(process.env.PORT || '8099', 10);
const OPTIONS_FILE = '/data/options.json';

// ─── Add-on configuration ─────────────────────────────────────────────────────

const DEFAULTS = {
  station_id:        'buero',
  station_name:      'Büro',
  available_targets: [
    { id: 'flur',      name: 'Flur'      },
    { id: 'werkstatt', name: 'Werkstatt' },
  ],
  ringtone:          'ring1',
  speaker_volume:    80,
  microphone_gain:   100,
  debug:             false,
};

function loadOptions() {
  try {
    const raw  = fs.readFileSync(OPTIONS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { ...DEFAULTS, ...data };
  } catch {
    console.log(`[InterCom] ${OPTIONS_FILE} nicht gefunden – verwende Standardwerte`);
    return { ...DEFAULTS };
  }
}

const options = loadOptions();
console.log(`[InterCom] Konfiguration: station="${options.station_id}" debug=${options.debug}`);

// ─── Express ──────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    stations: [...stations.entries()].map(([id, s]) => ({
      id, name: s.name, inCall: s.inCall,
    })),
  });
});

// Config API – read by the frontend on startup
app.get('/api/config', (_req, res) => {
  res.json(options);
});

// SPA fallback – required for HA Ingress sub-paths
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
// noServer + explicit upgrade handler: HA Ingress strips its prefix before
// forwarding, so the backend always receives the connection on /ws.
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ─── Station Registry ─────────────────────────────────────────────────────────
// Map<stationId, { ws, name, inCall }>
const stations = new Map();

function stationLabel(id) {
  // Prefer name from configured targets, fall back to built-in labels or id
  const t = options.available_targets?.find((x) => x.id === id);
  if (t) return t.name;
  const builtIn = { buero: 'Büro', flur: 'Flur', werkstatt: 'Werkstatt' };
  return builtIn[id] ?? id;
}

function ts()           { return new Date().toLocaleTimeString('de-DE'); }
function log(id, msg)   { console.log(`[${ts()}] [${id ?? '-'}] ${msg}`); }

function broadcastStations() {
  const list    = [...stations.entries()].map(([id, s]) => ({ id, name: s.name, inCall: s.inCall }));
  const payload = JSON.stringify({ type: 'stations', stations: list });
  for (const [, s] of stations) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(payload);
  }
}

function relay(fromId, msg) {
  const target = stations.get(msg.to);
  if (!target || target.ws.readyState !== WebSocket.OPEN) {
    const sender = stations.get(fromId);
    if (sender?.ws.readyState === WebSocket.OPEN) {
      sender.ws.send(JSON.stringify({ type: 'error', message: `${stationLabel(msg.to)} ist nicht erreichbar` }));
    }
    return;
  }
  target.ws.send(JSON.stringify({ ...msg, from: fromId }));
}

// ─── Signaling ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let id = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      case 'register': {
        const old = stations.get(msg.station);
        if (old && old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
          old.ws.send(JSON.stringify({ type: 'replaced' }));
          old.ws.close();
        }
        id = msg.station;
        // Accept the display name sent by the client (comes from config), fall back to label
        const name = msg.name || stationLabel(id);
        stations.set(id, { ws, name, inCall: false });
        log(id, `registriert als "${name}"`);
        ws.send(JSON.stringify({ type: 'registered', station: id, name }));
        broadcastStations();
        break;
      }

      case 'call-request': {
        if (!id) return;
        const target = stations.get(msg.to);
        if (!target) {
          ws.send(JSON.stringify({ type: 'error', message: `${stationLabel(msg.to)} ist offline` }));
          return;
        }
        if (target.inCall) {
          ws.send(JSON.stringify({ type: 'busy', from: msg.to }));
          return;
        }
        log(id, `→ ruft ${msg.to}`);
        relay(id, msg);
        break;
      }

      case 'call-accepted':
        if (!id) return;
        if (stations.has(id))     stations.get(id).inCall     = true;
        if (stations.has(msg.to)) stations.get(msg.to).inCall = true;
        log(id, `nimmt Anruf von ${msg.to} an`);
        relay(id, msg);
        broadcastStations();
        break;

      case 'call-rejected':
        if (!id) return;
        log(id, `lehnt Anruf von ${msg.to} ab`);
        relay(id, msg);
        break;

      case 'call-ended':
        if (!id) return;
        if (stations.has(id))     stations.get(id).inCall     = false;
        if (stations.has(msg.to)) stations.get(msg.to).inCall = false;
        log(id, `beendet Gespräch mit ${msg.to}`);
        relay(id, msg);
        broadcastStations();
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        if (id) relay(id, msg);
        break;

      default:
        log(id, `unbekannter Typ: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    if (id && stations.get(id)?.ws === ws) {
      log(id, 'getrennt');
      stations.delete(id);
      broadcastStations();
    }
  });

  ws.on('error', (err) => log(id, `WS-Fehler: ${err.message}`));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[InterCom] Läuft auf http://0.0.0.0:${PORT}`);
  console.log(`[InterCom] Config-API: http://0.0.0.0:${PORT}/api/config`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
