# ESP32 Relay Controller — MQTT API Documentation

MQTT interface inspired by WLED's topic layout.  
All topics are relative to the configured **prefix** (default `home/relay`).

---

## Topic Overview

```
{prefix}              ← input:  ON / OFF / T  (all relays)
{prefix}/api          ← input:  JSON API  (main control topic)
{prefix}/relay/N      ← input:  ON / OFF / T  (relay N)
{prefix}/relay/N/api  ← input:  JSON API  (relay N)
{prefix}/ping         ← input:  request state push
{prefix}/presence     ← input:  online / offline  (external web LWT)

{prefix}/v            → output: full JSON state  (retained)
{prefix}/relay/N/v    → output: on / off  (retained, per-relay)
{prefix}/status       → output: online / offline  (device LWT)
```

---

## Input Topics

### `{prefix}` — Simple global command

Send plain text to control all relays at once.

| Payload | Action |
|---------|--------|
| `ON` or `1` or `true` | Turn all relays ON |
| `OFF` or `0` or `false` | Turn all relays OFF |
| `T` or `TOGGLE` | Toggle all relays |

**Example:**
```
Topic:   home/relay
Payload: ON
```

---

### `{prefix}/api` — JSON API (main control topic)

The primary control topic. Accepts JSON payloads.  
After processing, the device immediately publishes updated state to `{prefix}/v`.

#### All relays on/off/toggle

```json
{"on": true}
{"on": false}
{"on": "t"}
```

| `on` value | Action |
|------------|--------|
| `true` / `1` / `"true"` / `"ON"` | All relays ON |
| `false` / `0` / `"false"` / `"OFF"` | All relays OFF |
| `"t"` / `"T"` / `"toggle"` / `"TOGGLE"` | Toggle all relays |

---

#### Single relay by index

```json
{"relay": 0, "on": true}
{"relay": 2, "on": "t"}
{"relay": 1, "pulse": 500}
{"relay": 3, "timer": 30}
```

| Field | Type | Description |
|-------|------|-------------|
| `relay` | int | Relay index (0-based) |
| `on` | bool / string | `true`/`false`/`"t"` |
| `pulse` | int | Pulse duration in **milliseconds** |
| `timer` | int | Auto-off timer in **seconds** |

---

#### Multiple relays at once

```json
{
  "relays": [
    {"id": 0, "on": true},
    {"id": 1, "on": false},
    {"id": 2, "pulse": 500},
    {"id": 3, "timer": 60}
  ]
}
```

---

#### Pattern sequencer

Start a pattern:
```json
{
  "pattern": {
    "steps": [
      {"mask": 1,  "duration_ms": 500},
      {"mask": 2,  "duration_ms": 500},
      {"mask": 4,  "duration_ms": 500},
      {"mask": 8,  "duration_ms": 500}
    ],
    "repeat": -1
  }
}
```

| Field | Description |
|-------|-------------|
| `mask` | Bitmask of relays to turn ON in this step. bit0=relay0, bit1=relay1, etc. |
| `duration_ms` | How long this step lasts in milliseconds |
| `repeat` | `-1` = infinite loop, `0` = play once, `N` = repeat N times |

Stop a pattern:
```json
{"pattern": "stop"}
{"pattern": false}
{"pattern": "off"}
```

---

### `{prefix}/relay/N` — Simple per-relay command

Replace `N` with the relay index (0-based).

| Payload | Action |
|---------|--------|
| `ON` or `1` | Turn relay N on |
| `OFF` or `0` | Turn relay N off |
| `T` or `TOGGLE` | Toggle relay N |
| `PULSE:500` | Pulse relay N for 500ms |
| `TIMER:30` | Turn relay N on, auto-off after 30s |

**Examples:**
```
Topic:   home/relay/relay/0
Payload: ON

Topic:   home/relay/relay/2
Payload: PULSE:1000
```

---

### `{prefix}/relay/N/api` — JSON per-relay command

Same JSON format as `/api` but targets relay N directly.  
No need to include `"relay"` field — it's implied by the topic.

```json
{"on": true}
{"on": "t"}
{"pulse": 500}
{"timer": 30}
```

**Examples:**
```
Topic:   home/relay/relay/0/api
Payload: {"on": true}

Topic:   home/relay/relay/1/api
Payload: {"pulse": 2000}
```

---

### `{prefix}/ping` — Request state push

Send any payload. Device responds by publishing full state to `{prefix}/v` and per-relay states to `{prefix}/relay/N/v`.

```
Topic:   home/relay/ping
Payload: 1
```

---

### `{prefix}/presence` — External web presence

Used by the remote web dashboard to announce itself. When the device receives `online`, it immediately pushes full state and begins periodic state updates (if configured).

```
Topic:   home/relay/presence
Payload: online
```
```
Topic:   home/relay/presence
Payload: offline
```

---

## Output Topics

### `{prefix}/v` — Full JSON state  *(retained)*

Published on connect, on any relay change, on ping, and on the configured state push interval.

```json
{
  "on": true,
  "num": 4,
  "ip": "192.168.1.42",
  "hostname": "relaycrtl",
  "relays": [
    {"id": 0, "name": "Pump",   "on": true,  "timer": 0},
    {"id": 1, "name": "Light",  "on": false, "timer": 0},
    {"id": 2, "name": "Fan",    "on": true,  "timer": 45},
    {"id": 3, "name": "Heater", "on": false, "timer": 0}
  ]
}
```

| Field | Description |
|-------|-------------|
| `on` | `true` if **any** relay is currently ON |
| `num` | Total number of configured relays |
| `ip` | Device IP address |
| `hostname` | mDNS hostname |
| `relays[].id` | Relay index (0-based) |
| `relays[].name` | Relay label (editable in web UI) |
| `relays[].on` | Current state |
| `relays[].timer` | Seconds remaining on auto-off timer, or `0` |

---

### `{prefix}/relay/N/v` — Per-relay state  *(retained)*

Simple string, retained.

| Payload | Meaning |
|---------|---------|
| `on` | Relay is ON |
| `off` | Relay is OFF |

**Example:**
```
Topic:   home/relay/relay/0/v
Payload: on
```

---

### `{prefix}/status` — Device LWT  *(retained)*

| Payload | Meaning |
|---------|---------|
| `online` | Device connected to broker |
| `offline` | Device disconnected (Last Will) |

---

## Home Assistant Examples

### Binary sensor (relay state)
```yaml
binary_sensor:
  - platform: mqtt
    name: "Pump"
    state_topic: "home/relay/relay/0/v"
    payload_on: "on"
    payload_off: "off"
    device_class: running
```

### Switch (control + state)
```yaml
switch:
  - platform: mqtt
    name: "Pump"
    state_topic: "home/relay/relay/0/v"
    command_topic: "home/relay/relay/0/api"
    payload_on:  '{"on":true}'
    payload_off: '{"on":false}'
    state_on: "on"
    state_off: "off"
```

### Device availability
```yaml
availability:
  - topic: "home/relay/status"
    payload_available: "online"
    payload_not_available: "offline"
```

---

## Node-RED Examples

### Turn relay 0 on
```json
{
  "topic": "home/relay/relay/0/api",
  "payload": "{\"on\":true}"
}
```

### Pulse relay 2 for 1 second
```json
{
  "topic": "home/relay/relay/2/api",
  "payload": "{\"pulse\":1000}"
}
```

### Run a chaser pattern
```json
{
  "topic": "home/relay/api",
  "payload": "{\"pattern\":{\"steps\":[{\"mask\":1,\"duration_ms\":200},{\"mask\":2,\"duration_ms\":200},{\"mask\":4,\"duration_ms\":200},{\"mask\":8,\"duration_ms\":200}],\"repeat\":-1}}"
}
```

---

## Quick Reference Card

```
ALL ON          →  home/relay       :  ON
ALL OFF         →  home/relay       :  OFF
ALL TOGGLE      →  home/relay       :  T

ALL ON (JSON)   →  home/relay/api   :  {"on":true}
ALL OFF (JSON)  →  home/relay/api   :  {"on":false}

RELAY 0 ON      →  home/relay/relay/0        :  ON
RELAY 0 ON      →  home/relay/relay/0/api    :  {"on":true}
RELAY 0 TOGGLE  →  home/relay/relay/0/api    :  {"on":"t"}
RELAY 0 PULSE   →  home/relay/relay/0/api    :  {"pulse":500}
RELAY 0 TIMER   →  home/relay/relay/0/api    :  {"timer":30}

MULTI RELAY     →  home/relay/api   :  {"relays":[{"id":0,"on":true},{"id":1,"on":false}]}
PING            →  home/relay/ping  :  1
STATE           ←  home/relay/v     :  {"on":...,"relays":[...]}
```

---

## Broker WebSocket Setup (for Remote Web Dashboard)

The remote web dashboard connects via WebSocket. Your broker needs WS enabled.

### Mosquitto (`mosquitto.conf`)
```
listener 1883        # standard MQTT
listener 9001        # WebSocket (plain)  ← for local hosting
protocol websockets

# For GitHub Pages (HTTPS) — needs WSS:
listener 8884
protocol websockets
cafile   /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile  /etc/mosquitto/certs/server.key
```

### Public test brokers (WSS)
| Broker | Host | WSS Port |
|--------|------|----------|
| HiveMQ Public | `broker.hivemq.com` | `8884` |
| test.mosquitto.org | `test.mosquitto.org` | `8081` |

> ⚠ Public brokers are shared — use a unique prefix like `myname/relay123` to avoid conflicts.
