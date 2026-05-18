'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

const PORT = parseInt(process.env.PORT || '8099', 10);

// ─── Express ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    stations: [...stations.entries()].map(([id, s]) => ({
      id,
      name:   s.name,
      inCall: s.inCall,
    })),
  });
});

// SPA fallback – needed for HA Ingress sub-paths
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
// noServer + explicit upgrade handler so HA Ingress can proxy /ws on any sub-path.
// HA strips its ingress prefix before forwarding, so the backend always sees /ws.
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

const LABELS = {
  buero:     'Büro',
  flur:      'Flur',
  werkstatt: 'Werkstatt',
};

function ts()  { return new Date().toLocaleTimeString('de-DE'); }
function log(id, msg) { console.log(`[${ts()}] [${id ?? '-'}] ${msg}`); }

function broadcastStations() {
  const list = [...stations.entries()].map(([id, s]) => ({
    id,
    name:   s.name,
    inCall: s.inCall,
  }));
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
      sender.ws.send(JSON.stringify({
        type:    'error',
        message: `${LABELS[msg.to] ?? msg.to} ist nicht erreichbar`,
      }));
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
        // Evict old session for same station
        const old = stations.get(msg.station);
        if (old && old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
          old.ws.send(JSON.stringify({ type: 'replaced' }));
          old.ws.close();
        }
        id = msg.station;
        stations.set(id, { ws, name: LABELS[id] ?? id, inCall: false });
        log(id, 'registriert');
        ws.send(JSON.stringify({ type: 'registered', station: id, name: LABELS[id] ?? id }));
        broadcastStations();
        break;
      }

      case 'call-request': {
        if (!id) return;
        const target = stations.get(msg.to);
        if (!target) {
          ws.send(JSON.stringify({ type: 'error', message: `${LABELS[msg.to] ?? msg.to} ist offline` }));
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
  console.log(`[Intercom] Läuft auf http://0.0.0.0:${PORT}`);
  console.log(`[Intercom] Health: http://0.0.0.0:${PORT}/health`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
