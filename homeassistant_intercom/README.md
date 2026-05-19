# HomeAssistant InterCom – Home Assistant Add-on

Lokales Audio/Video-Intercom-System für Android-Tablets.
**Kein Cloud-Dienst, kein externer Server** – läuft vollständig im LAN.

Alle Tablets teilen sich **eine einzige Add-on-Instanz**.
Jede Station wird über einen festen Link im Tablet-Browser zugewiesen.

---

## Netzwerk-Architektur

```
┌──────────────────────────────────────────────────────────────┐
│                   Home Assistant Server                      │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │         HomeAssistant InterCom Add-on               │   │
│   │                                                      │   │
│   │   ┌──────────────┐    ┌────────────────────────┐    │   │
│   │   │  Node.js     │    │  WebSocket Signaling   │    │   │
│   │   │  Express     │    │  Server (Port 8099)    │    │   │
│   │   │  (HTTP API)  │    │  ws://ha-ip:8099/ws    │    │   │
│   │   └──────────────┘    └────────────────────────┘    │   │
│   └─────────────────────────────────────────────────────┘   │
│           Port 8099 (direkt) oder HA Ingress (HTTPS)         │
└──────────────────────────────────────────────────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
   │   Tablet     │    │   Tablet     │    │   Tablet     │
   │   Büro       │    │   Flur       │    │  Werkstatt   │
   │  ?station=   │    │  ?station=   │    │  ?station=   │
   │   buero      │    │   flur       │    │  werkstatt   │
   └──────────────┘    └──────────────┘    └──────────────┘
         WebRTC P2P ←──────────────────────────► WebRTC P2P
         (direkte Peer-to-Peer Verbindung nach Signaling)
```

**Ablauf:**
1. Jedes Tablet öffnet seinen Stationslink (z. B. `?station=buero`)
2. Das Add-on erkennt die Station und gibt die passende Konfiguration zurück
3. Das Tablet registriert sich per WebSocket beim Signaling-Server
4. Beim Anruf vermittelt der Signaling-Server einmalig die Verbindungsdaten (SDP/ICE)
5. Danach läuft Audio/Video direkt zwischen den Tablets (WebRTC Peer-to-Peer)

---

## Installation

### Schritt 1 – GitHub Repository hinzufügen

1. Öffne in Home Assistant: **Einstellungen → Add-ons → Add-on Store**
2. Klicke oben rechts auf **⋮ (drei Punkte) → Repositories**
3. Füge folgende URL ein:
   ```
   https://github.com/choell401780/ha-tablet-intercom-addon
   ```
4. Klicke **Hinzufügen**, dann Seite neu laden (F5)

### Schritt 2 – Add-on installieren

1. Scrolle im Add-on Store nach unten bis "HomeAssistant InterCom" erscheint
2. Klicke auf das Add-on → **Installieren**
3. Warte bis die Installation abgeschlossen ist (kann 1–2 Minuten dauern)

### Schritt 3 – Stationen konfigurieren

1. Öffne das Add-on → Reiter **Konfiguration**
2. Trage alle deine Stationen ein (siehe Beispiel unten)
3. Klicke **Speichern**

### Schritt 4 – Add-on starten

1. Gehe zum Reiter **Info**
2. Klicke **Starten**
3. Warte bis der Status "Wird ausgeführt" (grüner Punkt) erscheint
4. Optional: **In der Seitenleiste anzeigen** aktivieren für schnellen Zugriff

---

## Add-on-Konfiguration

Alle Einstellungen werden **im HA-Backend** gesetzt.
Änderungen erfordern einen Neustart des Add-ons.

### Beispiel – 3 Stationen (Büro, Flur, Werkstatt)

```yaml
stations:
  - id: "buero"
    name: "Büro"
    ringtone: "ring1"
    speaker_volume: 80
    microphone_gain: 100

  - id: "flur"
    name: "Flur"
    ringtone: "ring2"
    speaker_volume: 90
    microphone_gain: 100

  - id: "werkstatt"
    name: "Werkstatt"
    ringtone: "ring3"
    speaker_volume: 100
    microphone_gain: 100

debug: false
```

### Beispiel – 5 Stationen

```yaml
stations:
  - id: "eingang"
    name: "Eingang"
    ringtone: "ring1"
    speaker_volume: 85
    microphone_gain: 120

  - id: "kueche"
    name: "Küche"
    ringtone: "ring2"
    speaker_volume: 90
    microphone_gain: 100

  - id: "wohnzimmer"
    name: "Wohnzimmer"
    ringtone: "ring1"
    speaker_volume: 75
    microphone_gain: 100

  - id: "keller"
    name: "Keller"
    ringtone: "ring3"
    speaker_volume: 100
    microphone_gain: 150

  - id: "buero"
    name: "Büro"
    ringtone: "ring4"
    speaker_volume: 80
    microphone_gain: 100

debug: false
```

### Erklärung der Felder

| Feld | Beschreibung | Wertebereich |
|---|---|---|
| `id` | Technische ID der Station – wird in der URL verwendet | Kleinbuchstaben, keine Sonderzeichen |
| `name` | Anzeigename im Intercom und bei Anrufen | Beliebiger Text |
| `ringtone` | Klingeltonmuster (ring1–ring5) | `ring1` bis `ring5` |
| `speaker_volume` | Standard-Lautstärke bei Gesprächsbeginn | 0–100 |
| `microphone_gain` | Verstärkung des Mikrofons | 0–300 |
| `debug` | Debug-Panel in der WebUI einblenden | `true` / `false` |

---

## station_id vs. station_name

**`id`** – die technische Kennung:
- Wird in der URL als `?station=buero` verwendet
- Muss eindeutig sein (kein doppelter Eintrag)
- Nur Kleinbuchstaben, Zahlen, Bindestriche – keine Umlaute, keine Leerzeichen
- Ändert sich möglichst nicht (Tablets müssen neu verlinkt werden wenn sich die ID ändert)
- Beispiele: `buero`, `flur`, `werkstatt`, `eingang`, `keller-sued`

**`name`** – der Anzeigename:
- Erscheint im Header des Tablets, in der Anrufliste und bei eingehenden Anrufen
- Kann Umlaute und Leerzeichen enthalten
- Kann jederzeit geändert werden (nur Add-on-Neustart nötig, kein Link-Update)
- Beispiele: `Büro`, `Flur`, `Werkstatt`, `Eingang`, `Keller Süd`

---

## Stationslinks – so funktioniert die Zuordnung

### Warum URL statt localStorage?

Ältere Ansätze speichern die Stationszuordnung im Browser-`localStorage` des Tablets.
Das hat mehrere Nachteile:

- **Instabil:** Browser können localStorage löschen (z. B. nach langer Inaktivität, App-Update, manuellem Löschen)
- **Schwer nachvollziehbar:** Nicht sofort erkennbar, welche Station ein Tablet ist
- **Fehleranfällig:** Bei Ersteinrichtung muss im Browser manuell etwas eingestellt werden

Der **URL-Ansatz** ist robuster:
- Der Link steckt in der Lesezeichenzeile oder der Kiosk-Browser-Konfiguration
- Jedes Tab weiß sofort beim Öffnen, welche Station es ist
- Kein Zustand im Browser – der Link ist die einzige Wahrheit
- Leicht überprüfbar: einfach die URL ansehen

### Stationsverwaltung öffnen

Öffne im Browser: `http://HOMEASSISTANT-IP:8099/admin`

oder über HA Ingress: Seitenleiste → InterCom → an URL `/admin` anhängen

Dort findest du:
- Den fertigen Stationslink für jede Station
- Einen **Kopieren**-Button
- Einen **QR-Code** zum Scannen mit dem Tablet

### Links manuell erstellen

Direktzugriff (IP):
```
http://HOMEASSISTANT-IP:8099/?station=buero
http://HOMEASSISTANT-IP:8099/?station=flur
http://HOMEASSISTANT-IP:8099/?station=werkstatt
```

Über HA Ingress (HTTPS, empfohlen):
```
https://homeassistant.domain.de/api/hassio_ingress/TOKEN/?station=buero
https://homeassistant.domain.de/api/hassio_ingress/TOKEN/?station=flur
https://homeassistant.domain.de/api/hassio_ingress/TOKEN/?station=werkstatt
```

> Den genauen Ingress-Token und damit den vollständigen Link siehst du
> in der **Stationsverwaltung** (`/admin`), da dieser aus deiner Browser-URL
> automatisch ermittelt wird.

---

## Beispiel – drei Tablets einrichten

### Vorbereitung

1. Add-on installieren und Stationen konfigurieren (siehe oben)
2. Stationsverwaltung öffnen: `http://HOMEASSISTANT-IP:8099/admin`
3. Für jedes Tablet den passenden Link notieren oder QR-Code scannen

### Tablet 1 – Büro

- Öffne Chrome auf dem Tablet
- Navigiere zu: `http://HOMEASSISTANT-IP:8099/?station=buero`
- Oder: QR-Code der Station "Büro" mit der Kamera scannen
- Kamera- und Mikrofonzugriff erlauben
- Das Tablet zeigt nun "Büro" im Header

**Dauerhaft einrichten (Fully Kiosk Browser):**
- Einstellungen → Startseiten-URL: `http://HOMEASSISTANT-IP:8099/?station=buero`
- Einstellungen → Web-Inhalte → Kamerazugriff erlauben: ✓
- Einstellungen → Web-Inhalte → Mikrofonzugriff erlauben: ✓

### Tablet 2 – Flur

- Link: `http://HOMEASSISTANT-IP:8099/?station=flur`
- Kamera/Mikrofon erlauben

### Tablet 3 – Werkstatt

- Link: `http://HOMEASSISTANT-IP:8099/?station=werkstatt`
- Kamera/Mikrofon erlauben

---

## Einbindung in Home Assistant

### iframe card (Dashboard)

```yaml
type: iframe
url: "http://HOMEASSISTANT-IP:8099/?station=buero"
aspect_ratio: 100%
allow: "camera; microphone"
title: Büro
```

> **Wichtig:** `allow: "camera; microphone"` ist Pflicht, damit Chrome
> Kamera und Mikrofon im iframe freigibt!

Beispiel für alle drei Stationen:

```yaml
# Dashboard-Karte Büro
type: iframe
url: "http://HOMEASSISTANT-IP:8099/?station=buero"
aspect_ratio: 100%
allow: "camera; microphone"
title: Büro

---

# Dashboard-Karte Flur
type: iframe
url: "http://HOMEASSISTANT-IP:8099/?station=flur"
aspect_ratio: 100%
allow: "camera; microphone"
title: Flur

---

# Dashboard-Karte Werkstatt
type: iframe
url: "http://HOMEASSISTANT-IP:8099/?station=werkstatt"
aspect_ratio: 100%
allow: "camera; microphone"
title: Werkstatt
```

### panel_iframe (Seitenleiste in configuration.yaml)

```yaml
panel_iframe:
  intercom_buero:
    title: "Büro"
    icon: mdi:video
    url: "http://HOMEASSISTANT-IP:8099/?station=buero"
  intercom_flur:
    title: "Flur"
    icon: mdi:video
    url: "http://HOMEASSISTANT-IP:8099/?station=flur"
  intercom_werkstatt:
    title: "Werkstatt"
    icon: mdi:video
    url: "http://HOMEASSISTANT-IP:8099/?station=werkstatt"
```

### Direkter Browser-Zugriff

Jeder Browser im LAN kann das Intercom öffnen – kein HA-Login nötig:

```
http://HOMEASSISTANT-IP:8099/?station=buero
```

Das ist praktisch zum Testen oder für Tablets ohne HA-Companion-App.

---

## Fully Kiosk Browser – Tipps

Fully Kiosk Browser ist ideal für dauerhaft laufende Tablet-Intercom-Stationen.

**Wichtige Einstellungen:**

| Einstellung | Wert |
|---|---|
| Startseiten-URL | `http://HOMEASSISTANT-IP:8099/?station=<id>` |
| Kamerazugriff erlauben | ✓ aktivieren |
| Mikrofonzugriff erlauben | ✓ aktivieren |
| Bildschirm ein bei Bewegung | Optional – nützlich für Türklingel-Automationen |
| Auto-Reload bei Fehler | ✓ aktivieren (z. B. nach 30 Sekunden) |
| WLAN-Verbindung prüfen | ✓ aktivieren |

**Warum Fully Kiosk Browser?**
- Behält Kiosk-Modus bei (kein "Zurück"-Button etc.)
- Startet nach Neustart des Tablets automatisch mit dem Stationslink
- Erlabt Automationen aus HA (z. B. Bildschirm einschalten per REST-API)
- Hält die App dauerhaft im Vordergrund

---

## Kamera- und Mikrofonrechte

Chrome/Chromium erlaubt `getUserMedia()` (Kamera/Mikrofon) **nur in sicheren Kontexten**.

| Zugangsweg | Kamera funktioniert? | Warum |
|---|---|---|
| Über HA Ingress (Seitenleiste) | ✅ Ja | HA stellt HTTPS bereit |
| `https://HA-IP:8099` | ✅ Ja (nach Warnung bestätigen) | HTTPS |
| `http://192.168.x.x:8099` | ❌ Nein | Unsicherer Kontext – Chrome blockiert |
| `http://localhost:8099` | ✅ Ja | localhost gilt als sicher |

**Empfehlung:** Zugriff über HA Ingress oder HTTPS verwenden.

Für direkten IP-Zugriff (ohne HTTPS) gibt es eine Chrome-Ausnahme:
> `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
> Dort die IP des HA-Servers eintragen (z. B. `http://192.168.1.10:8099`)

---

## Klingelton-Optionen

Die Klingeltöne werden per Web Audio API synthetisiert – keine Audiodateien nötig.

| Klingelton | Beschreibung | Klangmuster |
|---|---|---|
| `ring1` | Doppelton (Standard) | 880 Hz – kurze Pause – 880 Hz |
| `ring2` | Einzelton lang | 440 Hz lang – Pause |
| `ring3` | Dreifach-Ton | 1047 Hz × 3 schnell hintereinander |
| `ring4` | Absteigend | 880 Hz → 660 Hz → 440 Hz |
| `ring5` | Aufsteigend | 440 Hz → 660 Hz → 880 Hz |

Der Klingelton spielt auf der **Empfänger-Station** – also auf dem Tablet, das angerufen wird.
Jede Station kann einen eigenen Klingelton haben.

---

## Lautstärke-Optionen

### speaker_volume (Konferenz-Lautstärke)

Steuert die **Wiedergabe-Lautstärke** des eingehenden Gesprächs.
Wert 0–100 entspricht 0–100 % Lautstärke.

Diese Einstellung gilt als Standardwert beim Verbindungsaufbau.
Der Benutzer kann die Lautstärke **während des Gesprächs** über den Schieberegler anpassen.
Die Anpassung wird pro Session im localStorage gespeichert.

Empfohlene Werte:
- Leiser Raum (Büro): 70–80
- Normaler Raum: 80–90
- Lauter Raum (Werkstatt, Küche): 90–100

### microphone_gain (Mikrofon-Verstärkung)

Steuert die **Verstärkung des Mikrofons** dieser Station (Web Audio API GainNode).
Wert 100 = 1,0× (keine Änderung), 200 = 2,0× (doppelte Lautstärke).

Hilfreich wenn:
- Das Tablet-Mikrofon sehr leise ist → Wert erhöhen (z. B. 150–200)
- Echos oder Verzerrungen auftreten → Wert verringern (z. B. 80–90)
- In lauter Umgebung (Werkstatt) → ggf. ebenfalls erhöhen

---

## Erklärung der WebSocket-Verbindung

Das Intercom nutzt WebSockets für die **Signalisierung** (nicht für Audio/Video).

**Was läuft über WebSocket:**
- Station registriert sich beim Server (wer ist online?)
- Anruf-Anfragen (Klingeln)
- Anruf annehmen / ablehnen
- WebRTC-Aushandlung (SDP-Angebot, SDP-Antwort, ICE-Kandidaten)
- Gesprächsende

**Was NICHT über WebSocket läuft:**
- Audio und Video – das läuft **direkt zwischen den Tablets** (WebRTC Peer-to-Peer)
- Der Server ist nach dem Verbindungsaufbau nicht mehr am Gespräch beteiligt

**Reconnect-Logik:**
- Bei Verbindungsabbruch verbindet sich das Tablet automatisch nach 3 Sekunden erneut
- Der grüne/rote Punkt oben rechts zeigt den Verbindungsstatus
- Bei HA Ingress: WebSocket läuft als `wss://` (sicher/verschlüsselt)

---

## Fehlersuche

### "Kein Stationslink verwendet" – Fehlermeldung im Browser

Das Tablet hat die URL ohne `?station=` geöffnet.

**Lösung:** Öffne die Stationsverwaltung unter `/admin` und kopiere den Link für diese Station.

### "Unbekannte Station" – Fehlermeldung im Browser

Die Station-ID in der URL ist nicht in der Add-on-Konfiguration vorhanden.

**Mögliche Ursachen:**
- Tippfehler in der ID (Groß-/Kleinschreibung beachten: `buero` ≠ `Buero`)
- Station wurde aus der Konfiguration entfernt
- Add-on nach Konfigurationsänderung nicht neu gestartet

**Lösung:** Add-on-Konfiguration prüfen → Add-on neu starten → Stationslink erneut aus `/admin` kopieren

### Kamera/Mikrofon werden nicht freigegeben

→ HTTPS oder HA Ingress verwenden (Direktzugriff über HTTP blockiert Kamera)

### Station erscheint offline

→ Prüfen ob das Tablet denselben Add-on-Server erreicht (gleiche IP/Port)
→ Netzwerkverbindung des Tablets prüfen
→ Seite auf dem Tablet neu laden

### WebRTC verbindet nicht (kein Audio/Video)

1. `debug: true` in der Add-on-Konfiguration setzen → Add-on neu starten
2. Das Debug-Panel (unten auf dem Bildschirm) öffnet sich automatisch
3. Auf ICE-Kandidaten-Fehler achten
4. Häufigste Ursache: Firewall blockiert UDP-Ports zwischen den Tablets
5. Beide Tablets müssen im selben Netzwerk sein (oder UDP-Ports müssen freigegeben sein)

### Konfiguration wird nicht übernommen

→ Add-on immer neu starten nach jeder Konfigurationsänderung!

### Tablet zeigt "Offline" im Header

→ WebSocket-Verbindung unterbrochen – das Tablet verbindet sich automatisch neu
→ Wenn dauerhaft offline: Seite neu laden (F5 oder Swipe-to-Refresh)

---

## Ports

| Port | Verwendung |
|---|---|
| 8099/tcp | WebUI, WebSocket (`/ws`), Config-API (`/api/config`), Admin (`/admin`) |

---

## API-Endpunkte (für Entwickler)

| Endpunkt | Beschreibung |
|---|---|
| `GET /api/config?station=<id>` | Station-Konfiguration für Frontend |
| `GET /api/stations` | Alle Stationen (für Admin-Seite) |
| `GET /api/qr?url=<encoded-url>` | QR-Code als SVG |
| `GET /health` | Server-Status + Online-Stationen |
| `GET /admin` | Stationsverwaltungs-Seite |
| `WS /ws` | WebSocket Signaling |
