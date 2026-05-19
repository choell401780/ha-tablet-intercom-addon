'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');
const QRCode    = require('qrcode');

const PORT         = parseInt(process.env.PORT || '8099', 10);
const OPTIONS_FILE = '/data/options.json';

// ─── Add-on configuration ─────────────────────────────────────────────────────

const DEFAULTS = {
  stations: [
    { id: 'buero',     name: 'Büro',      ringtone: 'ring1', speaker_volume: 80,  microphone_gain: 100 },
    { id: 'flur',      name: 'Flur',      ringtone: 'ring2', speaker_volume: 90,  microphone_gain: 100 },
    { id: 'werkstatt', name: 'Werkstatt', ringtone: 'ring3', speaker_volume: 100, microphone_gain: 100 },
  ],
  debug: false,
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

const options    = loadOptions();
const stationCfg = new Map(options.stations.map((s) => [s.id, s]));

console.log(`[InterCom] ${options.stations.length} Stationen: ${options.stations.map((s) => s.id).join(', ')}`);
console.log(`[InterCom] debug=${options.debug}`);

// ─── Express ──────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    uptime:  Math.floor(process.uptime()),
    online:  [...registry.entries()].map(([id, s]) => ({ id, name: s.name, inCall: s.inCall })),
  });
});

// Station config API – called by the tablet frontend at boot
// GET /api/config?station=buero  → returns this station's config + all other stations as targets
// GET /api/config                → returns minimal station list (used by admin page)
app.get('/api/config', (req, res) => {
  const stationId = req.query.station;

  if (!stationId) {
    return res.json({
      stations: options.stations.map((s) => ({ id: s.id, name: s.name })),
      debug:    options.debug,
    });
  }

  const station = stationCfg.get(stationId);
  if (!station) {
    return res.status(404).json({
      error:     'station_not_found',
      station:   stationId,
      available: options.stations.map((s) => s.id),
    });
  }

  const targets = [
    ...options.stations
      .filter((s) => s.id !== stationId)
      .map((s) => ({ id: s.id, name: s.name })),
    { id: 'all', name: 'Alle' },
  ];

  res.json({
    station: {
      id:              station.id,
      name:            station.name,
      ringtone:        station.ringtone,
      speaker_volume:  station.speaker_volume,
      microphone_gain: station.microphone_gain,
    },
    targets,
    debug: options.debug,
  });
});

// Admin API – full station list for the management page
app.get('/api/stations', (_req, res) => {
  res.json({ stations: options.stations, debug: options.debug });
});

// Station-Links API – returns stations with pre-built links when server can detect the base URL.
// HA Ingress sets X-Ingress-Path + X-Forwarded-* headers; direct access uses the request host.
// If the full external URL cannot be determined server-side, link is null and the client
// generates it from window.location (see admin.html getBaseUrl()).
app.get('/api/station-links', (req, res) => {
  const ingressPath    = (req.headers['x-ingress-path']   || '').replace(/\/$/, '');
  const forwardedProto = req.headers['x-forwarded-proto'] || null;
  const forwardedHost  = req.headers['x-forwarded-host']  || null;

  let base = null;
  if (ingressPath && forwardedProto && forwardedHost) {
    // Full HA Ingress context available
    base = `${forwardedProto}://${forwardedHost}${ingressPath}/`;
  } else if (!ingressPath) {
    // Direct port access – host header is reliable here
    const host = req.headers.host || `localhost:${PORT}`;
    base = `http://${host}/`;
  }
  // Ingress present but forwarded headers missing → base stays null, client handles URL

  const links = options.stations.map((s) => ({
    id:              s.id,
    name:            s.name,
    ringtone:        s.ringtone,
    speaker_volume:  s.speaker_volume,
    microphone_gain: s.microphone_gain,
    link:            base ? `${base}?station=${encodeURIComponent(s.id)}` : null,
  }));

  res.json({ base: base || null, links, debug: options.debug });
});

// QR code endpoint – generates SVG QR code for any URL
// GET /api/qr?url=https%3A%2F%2F...
app.get('/api/qr', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });
  try {
    const svg = await QRCode.toString(url, {
      type:                 'svg',
      errorCorrectionLevel: 'M',
      width:                220,
      margin:               1,
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Station management page
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
const registry = new Map();

function stationLabel(id) {
  return stationCfg.get(id)?.name ?? id;
}

function ts()           { return new Date().toLocaleTimeString('de-DE'); }
function log(id, msg)   { console.log(`[${ts()}] [${id ?? '-'}] ${msg}`); }

function broadcastStations() {
  const list    = [...registry.entries()].map(([id, s]) => ({ id, name: s.name, inCall: s.inCall }));
  const payload = JSON.stringify({ type: 'stations', stations: list });
  for (const [, s] of registry) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(payload);
  }
}

function relay(fromId, msg) {
  const target = registry.get(msg.to);
  if (!target || target.ws.readyState !== WebSocket.OPEN) {
    const sender = registry.get(fromId);
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
        // Only accept stations that are defined in the add-on config
        if (!stationCfg.has(msg.station)) {
          ws.send(JSON.stringify({
            type:    'error',
            message: `Station "${msg.station}" ist nicht konfiguriert`,
          }));
          ws.close();
          return;
        }
        const old = registry.get(msg.station);
        if (old && old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
          old.ws.send(JSON.stringify({ type: 'replaced' }));
          old.ws.close();
        }
        id = msg.station;
        const name = msg.name || stationLabel(id);
        registry.set(id, { ws, name, inCall: false, broadcastTargets: null });
        log(id, `registriert als "${name}"`);
        ws.send(JSON.stringify({ type: 'registered', station: id, name }));
        broadcastStations();
        break;
      }

      case 'call-request': {
        if (!id) return;
        if (msg.to === 'all') {
          const available = [...registry.entries()]
            .filter(([tid, ts]) => tid !== id && !ts.inCall && ts.ws.readyState === WebSocket.OPEN);
          if (available.length === 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'Keine anderen Stationen online oder verfügbar' }));
            return;
          }
          const targetIds = new Set(available.map(([tid]) => tid));
          registry.get(id).broadcastTargets = targetIds;
          log(id, `→ ruft alle: ${[...targetIds].join(', ')}`);
          for (const [, ts] of available) {
            ts.ws.send(JSON.stringify({ type: 'call-request', from: id }));
          }
          break;
        }
        const target = registry.get(msg.to);
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

      case 'call-accepted': {
        if (!id) return;
        const callerEntry = registry.get(msg.to);
        if (callerEntry?.broadcastTargets) {
          for (const tid of callerEntry.broadcastTargets) {
            if (tid !== id) {
              const ts = registry.get(tid);
              if (ts?.ws.readyState === WebSocket.OPEN) {
                ts.ws.send(JSON.stringify({ type: 'call-ended', from: msg.to }));
              }
            }
          }
          callerEntry.broadcastTargets = null;
        }
        if (registry.has(id))     registry.get(id).inCall     = true;
        if (registry.has(msg.to)) registry.get(msg.to).inCall = true;
        log(id, `nimmt Anruf von ${msg.to} an`);
        relay(id, msg);
        broadcastStations();
        break;
      }

      case 'call-rejected': {
        if (!id) return;
        const callerRej = registry.get(msg.to);
        if (callerRej?.broadcastTargets?.has(id)) {
          callerRej.broadcastTargets.delete(id);
          log(id, `lehnt Broadcast-Anruf ab (verbleibend: ${callerRej.broadcastTargets.size})`);
          if (callerRej.broadcastTargets.size === 0) {
            callerRej.broadcastTargets = null;
            if (callerRej.ws.readyState === WebSocket.OPEN) {
              callerRej.ws.send(JSON.stringify({ type: 'call-rejected', from: id }));
            }
          }
        } else {
          log(id, `lehnt Anruf von ${msg.to} ab`);
          relay(id, msg);
        }
        break;
      }

      case 'call-ended': {
        if (!id) return;
        const myEntry = registry.get(id);
        if (myEntry?.broadcastTargets) {
          for (const tid of myEntry.broadcastTargets) {
            const ts = registry.get(tid);
            if (ts?.ws.readyState === WebSocket.OPEN) {
              ts.ws.send(JSON.stringify({ type: 'call-ended', from: id }));
            }
          }
          myEntry.broadcastTargets = null;
          log(id, 'bricht Broadcast-Anruf ab');
          broadcastStations();
          break;
        }
        if (registry.has(id))     registry.get(id).inCall     = false;
        if (registry.has(msg.to)) registry.get(msg.to).inCall = false;
        log(id, `beendet Gespräch mit ${msg.to}`);
        relay(id, msg);
        broadcastStations();
        break;
      }

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
    if (id && registry.get(id)?.ws === ws) {
      log(id, 'getrennt');
      registry.delete(id);
      broadcastStations();
    }
  });

  ws.on('error', (err) => log(id, `WS-Fehler: ${err.message}`));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[InterCom] Läuft auf http://0.0.0.0:${PORT}`);
  console.log(`[InterCom] Stationsverwaltung: http://0.0.0.0:${PORT}/admin`);
  console.log(`[InterCom] Config-API:         http://0.0.0.0:${PORT}/api/config?station=<id>`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
