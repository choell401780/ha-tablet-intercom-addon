# HomeAssistant InterCom – Home Assistant Add-on

Lokales Audio/Video-Intercom-System für Android-Tablets.  
Kein Cloud-Dienst, kein externer Server – läuft vollständig im LAN.

**Stationen:** Büro · Flur · Werkstatt

---

## Installation

### 1. Repository in Home Assistant hinzufügen

1. **Einstellungen → Add-ons → Add-on Store**
2. Oben rechts: **⋮ → Repositories**
3. URL einfügen:
   ```
   https://github.com/DEIN-USERNAME/ha-tablet-intercom-addon
   ```
4. **Hinzufügen** → Seite neu laden

### 2. Add-on installieren

- Im Add-on Store unter **„HomeAssistant InterCom"** auf **Installieren** klicken
- Warten bis der Docker-Build abgeschlossen ist (~1–2 Min.)

### 3. Add-on starten

- **Starten** klicken
- Optional: **„Beim Start ausführen"** aktivieren
- Im Tab **Protokoll** prüfen:
  ```
  [Intercom] Läuft auf http://0.0.0.0:8099
  ```

### 4. WebUI öffnen

Direkte URL (Browser oder iframe):
```
http://HOMEASSISTANT-IP:8099
```

Oder über den **Seitenleisten-Button** in Home Assistant (wird automatisch eingeblendet).

---

## Kamera-Berechtigung (wichtig!)

Android Chrome erlaubt `getUserMedia()` nur in sicheren Kontexten.

| Zugang | Kamera funktioniert? |
|---|---|
| Über HA Ingress (Seitenleiste) | ✅ automatisch (HTTPS) |
| `https://HA-IP:8099` | ✅ nach Zertifikatswarnung bestätigen |
| `http://HA-IP:8099` | ❌ Chrome blockiert Kamera |

**Empfehlung:** Immer über HA Ingress oder HTTPS zugreifen.

---

## Einbindung in Home Assistant

### Variante A – iframe card (Dashboard)

Dashboard bearbeiten → **Karte hinzufügen → Webseite**:

```yaml
type: iframe
url: http://HOMEASSISTANT-IP:8099
aspect_ratio: 100%
allow: "camera; microphone"
title: Intercom
```

> `allow: "camera; microphone"` ist zwingend nötig, damit Chrome Kamera/Mikro im iframe erlaubt.

### Variante B – panel_iframe (eigener Menüpunkt)

In `configuration.yaml`:

```yaml
panel_iframe:
  homeassistant_intercom:
    title: HomeAssistant InterCom
    icon: mdi:video
    url: http://HOMEASSISTANT-IP:8099
```

Nach `ha core restart` erscheint „HomeAssistant InterCom" in der Seitenleiste.

---

## Bedienung

1. Seite auf jedem Tablet im Browser öffnen
2. Station auswählen (wird im Browser gespeichert)
3. Kamera und Mikrofon freigeben
4. Online-Stationen erscheinen als Schaltflächen
5. Station antippen → Anruf startet
6. Gegenstelle nimmt an → WebRTC-Videoverbindung
7. **Auflegen** beendet den Anruf

---

## Ports

| Port | Protokoll | Verwendung |
|------|-----------|------------|
| 8099 | TCP | WebUI & WebSocket Signaling |

---

## Technische Details

- **Backend:** Node.js + Express + ws (WebSocket)
- **Signaling:** WebSocket auf Port 8099
- **Video/Audio:** WebRTC (Peer-to-Peer im LAN)
- **Stationsspeicher:** `localStorage` im Browser
- **Keine Daten** verlassen das lokale Netzwerk

---

## Fehlerbehebung

**Kamera wird nicht freigegeben**  
→ Zugriff über HTTPS oder HA Ingress verwenden

**Station erscheint nicht in der Liste**  
→ Sicherstellen, dass beide Tablets mit demselben Add-on verbunden sind (gleiche IP/URL)

**WebRTC verbindet nicht**  
→ Debug-Panel öffnen (Schaltfläche unten rechts) – ICE-Status prüfen  
→ Beide Tablets müssen im gleichen LAN sein

**WebSocket trennt sich ständig**  
→ Proxy-Timeout prüfen (bei Nginx/HA Ingress ggf. `proxy_read_timeout` erhöhen)
