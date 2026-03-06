# Relay Ctrl — Remote Dashboard

Controls ESP32 Relay Controllers and WLED devices from any browser.

## Device Types

| Type | Protocol | Broker needed | Local network needed | HTTPS compatible |
|------|----------|---------------|----------------------|------------------|
| Relay Controller | MQTT over WSS | ✅ Yes | ❌ No | ✅ Yes |
| WLED (MQTT) | MQTT over WSS | ✅ Yes | ❌ No | ✅ Yes |
| WLED (WebSocket) | ws:// direct | ❌ No | ✅ Yes | ⚠ Browser asks once |

**WLED WebSocket on HTTPS:** browser shows a "mixed content" permission prompt once — same as when you allow `fetch(http://)`. Accept it and WebSocket works normally.

## MQTT Broker (for Relay + WLED-MQTT)

Free public broker for testing: `broker.hivemq.com` port `8884` (WSS)

## WLED Setup

### WLED via MQTT
Settings → Sync Interfaces → MQTT — set same broker + topic prefix.

### WLED via WebSocket
Just enter the IP/hostname. No WLED config needed — connects to `/ws` directly.
