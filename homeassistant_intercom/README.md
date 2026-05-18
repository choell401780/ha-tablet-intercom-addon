# HomeAssistant InterCom – Home Assistant Add-on

Lokales Audio/Video-Intercom-System für Android-Tablets.
Kein Cloud-Dienst, kein externer Server – läuft vollständig im LAN.

**Station und alle Einstellungen werden im HA Add-on-Konfigurationsbereich gesetzt.**

---

## Installation

### 1. Repository hinzufügen

1. **Einstellungen → Add-ons → Add-on Store**
2. Oben rechts: **⋮ → Repositories**
3. URL einfügen:
   ```
   https://github.com/choell401780/ha-tablet-intercom-addon
   ```
4. **Hinzufügen** → Seite neu laden

### 2. Add-on installieren & konfigurieren

- Add-on installieren
- Reiter **Konfiguration** öffnen
- Station und Einstellungen setzen (siehe unten)
- **Starten**

---

## Add-on-Konfiguration

Alle Einstellungen werden im HA-Backend gesetzt, **nicht** in der Web-Oberfläche.

```yaml
station_id: "buero"          # Technische ID dieser Station
station_name: "Büro"         # Anzeigename im Header

available_targets:            # Stationen, die dieses Tablet anrufen kann
  - id: "flur"
    name: "Flur"
  - id: "werkstatt"
    name: "Werkstatt"

ringtone: "ring1"             # Klingelton: ring1 bis ring5
speaker_volume: 80            # Standard-Lautstärke 0–100 %
microphone_gain: 100          # Mikrofon-Verstärkung 0–300 %
debug: false                  # Debug-Panel in der WebUI einblenden
```

> Änderungen an der Konfiguration erfordern einen **Neustart** des Add-ons.

---

## Mehrere Tablets – ein Add-on

Ein Add-on-Prozess bedient alle Tablets gleichzeitig als Signaling-Server.

**Option A – Station per iframe-URL** (empfohlen):
```
http://HOMEASSISTANT-IP:8099?station=buero     ← Büro-Tablet
http://HOMEASSISTANT-IP:8099?station=flur      ← Flur-Tablet
http://HOMEASSISTANT-IP:8099?station=werkstatt ← Werkstatt-Tablet
```
Der URL-Parameter `?station=` überschreibt die `station_id` in der Konfiguration.
Der Anzeigename wird aus `available_targets` ermittelt.

**Option B – Mehrere Add-on-Instanzen** (separater Port je Tablet):
Jedes Tablet bekommt eine eigene Add-on-Instanz mit unterschiedlichem Port und `station_id`.

---

## Einbindung in Home Assistant

### iframe card (Dashboard)

```yaml
type: iframe
url: "http://HOMEASSISTANT-IP:8099?station=buero"
aspect_ratio: 100%
allow: "camera; microphone"
title: Büro
```

> `allow: "camera; microphone"` ist **Pflicht**, damit Chrome Kamera/Mikro im iframe freigibt.

### panel_iframe (Seitenleiste)

```yaml
panel_iframe:
  intercom_buero:
    title: "Büro"
    icon: mdi:video
    url: "http://HOMEASSISTANT-IP:8099?station=buero"
  intercom_flur:
    title: "Flur"
    icon: mdi:video
    url: "http://HOMEASSISTANT-IP:8099?station=flur"
```

---

## Was der Benutzer in der WebUI noch selbst einstellen kann

| Einstellung | Wo |
|---|---|
| **Lautstärke während eines Gesprächs** | Schieberegler in den Anruf-Steuertasten |

Alle anderen Einstellungen (Station, Klingelton, Gain, Debug) sind **nur im HA-Backend** konfigurierbar.

---

## Kamera-Berechtigung

Android Chrome erlaubt `getUserMedia()` nur in sicheren Kontexten.

| Zugang | Kamera funktioniert? |
|---|---|
| Über HA Ingress (Seitenleiste) | ✅ automatisch (HTTPS) |
| `https://HA-IP:8099` | ✅ nach Zertifikatswarnung bestätigen |
| `http://HA-IP:8099` | ❌ Chrome blockiert Kamera |

**Empfehlung:** Zugriff über HA Ingress oder HTTPS.

---

## Ports

| Port | Verwendung |
|---|---|
| 8099/tcp | WebUI, WebSocket (`/ws`), Config-API (`/api/config`) |

---

## Fehlerbehebung

**Kamera wird nicht freigegeben** → HTTPS oder HA Ingress verwenden

**Station erscheint offline** → Beide Tablets müssen dieselbe Add-on-URL verwenden; `available_targets` in der Konfiguration prüfen

**WebRTC verbindet nicht** → Debug in der Konfiguration auf `true` setzen, Debug-Panel in der WebUI prüfen

**Konfiguration nicht übernommen** → Add-on neu starten nach Konfigurationsänderung
