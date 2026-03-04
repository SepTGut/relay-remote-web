# Relay Ctrl — Remote Web Dashboard

## ⚠ GitHub Pages / HTTPS — WSS Required

GitHub Pages serves over **HTTPS**. Browsers block plain WebSocket (`ws://`) from HTTPS pages (mixed content). Your MQTT broker **must support `wss://`** (WebSocket over TLS).

The page auto-detects HTTPS and forces TLS on — you just need the right port.

| Broker | WSS Port |
|---|---|
| EMQX (cloud/local) | 8084 |
| HiveMQ Cloud | 8884 |
| Mosquitto (self-hosted + TLS) | 8081 or 8884 |
| HiveMQ Public Broker (`broker.hivemq.com`) | 8884 |
| test.mosquitto.org | 8081 |

**Easiest option for testing:** use `broker.hivemq.com` port `8884` — it's free, public, no signup.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell |
| `remote.css` | Styles |
| `remote.js` | All logic |
| `README.md` | This file |

## Setup

1. Push all files to a GitHub repo, enable Pages (Settings → Pages → main branch / root).
2. Open your Pages URL.
3. Enter broker host + WSS port, click **Connect**.
4. Click **+ Add Device**, enter a name and the topic prefix matching your ESP32 config (default `home/relay`).

## Broker — Mosquitto self-hosted (WSS)

`mosquitto.conf`:
```
listener 1883
listener 8884
protocol websockets
cafile   /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile  /etc/mosquitto/certs/server.key
```

## MQTT Topics

### ESP32 → Remote
| Topic | Payload |
|---|---|
| `{prefix}/state` | Full JSON state (retained) |
| `{prefix}/{id}/state` | `ON` / `OFF` (retained) |
| `{prefix}/status` | `online` / `offline` (LWT) |

### Remote → ESP32
| Topic | Payload |
|---|---|
| `{prefix}/ping` | `1` — request full state |
| `{prefix}/presence` | `online` / `offline` |
| `{prefix}/cmd` | JSON command (see below) |
| `{prefix}/alloff` · `{prefix}/allon` | `1` |
| `{prefix}/{id}/set` | `ON`/`OFF`/`TOGGLE` or JSON |

### JSON Command Examples
```json
{"id": 0, "state": true}
{"id": "all", "state": false}
{"id": 2, "pulse": 500}
{"id": 1, "timer": 30}
[{"id":0,"state":true}, {"id":1,"pulse":1000}]
```


## Files

| File | Purpose |
|---|---|
| `index.html` | Main page shell |
| `remote.css` | All styles |
| `remote.js` | All logic (MQTT, UI, state) |

## Hosting

Drop all three files on **any static web host** — GitHub Pages, Netlify, a local nginx/Apache, even open `index.html` directly in a browser.

### GitHub Pages (quickest)
```bash
git init && git add . && git commit -m "remote web"
# push to GitHub, enable Pages in repo settings → root
```

### Local nginx
```nginx
server {
  listen 8080;
  root /var/www/relay-remote;
}
```

### Direct browser
Just open `index.html` — no build step, no npm, no server required.

---

## Broker Requirements

Your MQTT broker must expose a **WebSocket port** (default 9001).

### Mosquitto
Add to `mosquitto.conf`:
```
listener 1883
listener 9001
protocol websockets
```

### HiveMQ / EMQX / Mosquitto Cloud
WebSocket is usually enabled on port 8083 (ws) or 8084 (wss/TLS).

---

## Setup

1. Open the dashboard in a browser.
2. Enter your broker host, WebSocket port, and credentials.
3. Click **Connect**.
4. Click **+ Add Device**, enter a name and the **topic prefix** that matches the ESP32 firmware config (default `home/relay`).
5. The device will ping, and relay state will appear automatically.

---

## MQTT Topics

All topics are relative to the configured prefix (e.g. `home/relay`).

### ESP32 → Remote
| Topic | Payload | Description |
|---|---|---|
| `{prefix}/state` | JSON | Full state dump (retained) |
| `{prefix}/{id}/state` | `ON` / `OFF` | Per-relay state (retained) |
| `{prefix}/status` | `online` / `offline` | Device LWT |

### Remote → ESP32
| Topic | Payload | Description |
|---|---|---|
| `{prefix}/ping` | `1` | Request full state dump |
| `{prefix}/presence` | `online` / `offline` | Remote web LWT — ESP32 starts pushing state |
| `{prefix}/cmd` | JSON | Bulk command (see below) |
| `{prefix}/json` | JSON | Alias for `/cmd` |
| `{prefix}/alloff` | `1` | All relays OFF |
| `{prefix}/allon` | `1` | All relays ON |
| `{prefix}/{id}/set` | string or JSON | Control one relay |

### JSON Command Examples

**Single relay:**
```json
{"id": 0, "state": true}
{"id": 2, "pulse": 500}
{"id": 1, "timer": 30}
{"id": 3, "toggle": 1}
```

**All relays:**
```json
{"id": "all", "state": false}
```

**Array (bulk):**
```json
[
  {"id": 0, "state": true},
  {"id": 1, "pulse": 1000},
  {"id": 2, "timer": 60}
]
```

---

## State Push Interval

On the ESP32 settings page (`http://<device-ip>`), set **State Push Interval** under MQTT settings.
When the remote web is connected and announces presence, the ESP32 pushes a full JSON state update every N seconds.
Set to `0` to push only on change / ping.

---

## Multi-Device

Add multiple devices with different prefixes. Each device:
- Gets its own sidebar entry with online/offline status
- Is subscribed and pinged independently
- Can be controlled from the same dashboard simultaneously

---

## Browser Requirement

Any modern browser. No build tools, no frameworks, no backend.
Paho MQTT JS is loaded from the Cloudflare CDN — needs internet access, or self-host it alongside these files.

**Self-hosting Paho:**
Download from https://www.eclipse.org/paho/files/jsclient/paho-mqtt.min.js  
Place it in the same folder and update `index.html`:
```html
<script src="paho-mqtt.min.js"></script>
```
