# Relay Ctrl Remote Dashboard

## Transport Options

| Device Type | Protocol | GitHub Pages HTTPS | Local HTTP |
|-------------|----------|-------------------|------------|
| Relay Controller (MQTT) | MQTT WSS | ✅ Works | ✅ Works |
| WLED (MQTT) | MQTT WSS | ✅ Works | ✅ Works |
| WLED (WebSocket) | ws:// direct | ⚠ Needs unlock | ✅ Works |
| WLED (HTTP Poll) | http:// fetch | ⚠ Needs unlock | ✅ Works |

## Unlock Mixed Content in Chrome (for WS / HTTP Poll on HTTPS)

Chrome 94+ removed the popup. Manual steps:
1. Click the **🔒 lock icon** in address bar
2. Click **Site settings**
3. Find **Insecure content** → set to **Allow**
4. Reload the page

Firefox: click the **shield icon** in address bar → disable protection for this site.

## MQTT Broker

Free public broker for testing: `broker.hivemq.com` port `8884` (WSS/TLS)

## WLED MQTT Setup

WLED → Settings → Sync Interfaces → MQTT:
- Set same broker host and port
- Set a Topic (prefix), e.g. `wled/mystrip`
- Add same prefix in dashboard as WLED (MQTT) device

## WLED HTTP Poll

Same API as your standalone relay control page:
- Reads state from `GET /json`
- Toggles via `GET /relays?switch=0,1,0,1`
- JSON control via `POST /json/state`
