# GEODNET GNSS Local Network Dashboard

A real-time satellite tracker and local-network dashboard for a **physical GEODNET / HYFIX
MobileCM GNSS base station** (model `MCMv3`, Triple-Band, UM980 receiver).

Runs **100% locally**: no cloud APIs required, no external internet, no third-party auth tokens.

```
node server.js          # -> http://127.0.0.1:3000
```

---

## What it does

- Polls the base station's own web API on the LAN and normalizes the telemetry.
- Serves one clean proxy route: `GET /api/live-telemetry`.
- Renders a Plotly **GNSS skyplot**: centre = 90° elevation (overhead), outer rim = 0°
  elevation (horizon), angular axis clockwise N → E → S → W.
- Colour-codes satellites by constellation (GPS cyan, GLONASS crimson, Galileo emerald,
  BeiDou amber) and scales each dot's pixel diameter by live SNR.
- Refreshes every 4 s and animates marker movement without a page reload.

---

## Configuration (all optional, all env vars)

| Variable | Default | Purpose |
|---|---|---|
| `MINER_IP` | `192.168.2.11` | Base station IP |
| `MINER_PORT` | `80` | Base station web port |
| `PORT` | `3000` | Dashboard HTTP port |
| `MINER_KEY` | *(device SN)* | Miner Key for the device web login |
| `GEODNET_APP_ID` | *(unset)* | GEODNET tenant app id (see below) |
| `GEODNET_APP_KEY` | *(unset)* | GEODNET tenant app key (see below) |
| `GEODNET_MOUNTPOINT` | *(unset)* | Station mountpoint, e.g. `C82E1891C0A9` |
| `GEODNET_API_BASE` | `https://rtk.geodnet.com/api/v3` | GEODNET API base (override for testing) |

Nothing is hard-coded. The app runs with zero GEODNET credentials.

---

## The device API (discovered on this hardware)

The MobileCM web UI lives at `http://<MINER_IP>/` and is a **Miner Key** login, not HTTP Basic:

```
POST /login           mkey=<MINER_KEY>          -> base64("admin:<key>") as the USER cookie
GET  /devStatus       (no auth required)        -> hardware + stream status
GET  /admin/config/mi (with cookie)              -> {"key":"<miner key>"}
```

`/devStatus` returns:

```json
{ "role":"0", "wifiStrength":"-47", "nsStatus":"TRANSMITTING",
  "upDateRate":"1307.58", "gnssDataRate":"1127.92", "ts":"2026-10-24 04:12:35",
  "uptime":"7.29(days)", "fwVer":"MCMv3-2.2.1@20250711", "hwVer":"MCMv3",
  "sn":"C82E1891C0A9", "gnss":"Triple-Band",
  "gnssVer":"UM980R4.10Build13375@24/03/26" }
```

Full endpoint list found in the device's own HTML: `/devStatus`, `/admin/config/{mi,mk,wifi}`,
`/admin/debug/ping`, `/ota/{app,gnss/,online}`, `/netHistory`, `/mcmWS` (WebSocket), `/login`.

### Endpoint fallback chain

The backend walks this list and keeps whichever answer works:

1. `GET /status.json` — generic firmware revision A
2. `GET /cgi-bin/status` — generic firmware revision B
3. `GET /devStatus` — the actual MobileCM/HYFIX endpoint on this hardware

Each poll has a hard **3-second timeout**; an unreachable device yields a structured
`OFFLINE` JSON payload (never a stack trace, never a crash).

### Important limitation

This firmware revision exposes **hardware and stream status but no per-satellite telemetry**.
The WebSocket `/mcmWS` only carries OTA progress messages, and there is no local RTCM/NTRIP
server on the device (full 1–65535 TCP and UDP scans found only port 80). Per-satellite data
therefore comes from the GEODNET cloud API when credentials are supplied.

---

## GEODNET cloud source (optional)

`api/v3/station/info` returns per-satellite **PRN + SNR** for a base station:

```json
{ "code":1000, "data": { "satInfo": {
    "satinfoG":[{"prn":6,"snr":51}], "satinfoR":[{"prn":49,"snr":51}],
    "satinfoE":[{"prn":7,"snr":50}],  "satinfoC":[{"prn":2,"snr":44}],
    "satinfoI":[{"prn":2,"snr":43}],  "satinfoJ":[{"prn":194,"snr":44}] },
  "uptimes":[{"time":"...","hour":"06","day":"15","rate":100}] } }
```

### Request signing

```
1. sort all request params by key (ascending), EXCLUDING appKey and sign
2. concatenate their VALUES in that order
3. append appKey
4. sign = md5_hex(result)          # lowercase hex
```

Verified against the published GEODNET reference example
(`appId=geodnet, username=geoduser, password=geodpass, trialDays=7, time=1718150400000`
→ `8dd687e158219da6ccc689aef6c0a6a1`) — exact match.

`appId` / `appKey` are tenant credentials issued by GEODNET (`support@geodnet.com`).
The doc's public example key `2916350764adb542` is accepted by the reseller `user/*`
endpoints; the `station/info` endpoint uses a different tenant key, so
`GEODNET_APP_ID` / `GEODNET_APP_KEY` must be requested from GEODNET for satellite data.
Until then the app still reports live hardware status and shows an empty skyplot.

---

## API

### `GET /api/live-telemetry`

```json
{
  "ok": true, "status": "ONLINE", "connected": true,
  "source_endpoint": "devStatus",
  "hardware": { "serial_number":"C82E1891C0A9", "uptime":"7.29(days)",
                "software_version":"MCMv3-2.2.1@20250711", "model":"MCMv3",
                "gnss_receiver":"UM980R4.10Build13375@24/03/26",
                "gnss_band":"Triple-Band", "status_raw":"TRANSMITTING" },
  "summary": { "total_tracked":30, "gps":9, "glonass":7, "galileo":8, "beidou":6,
               "average_snr":33.2 },
  "satellites_detail": [ { "id":1, "constellation":"GPS",
                           "elevation":15.3, "azimuth":2, "snr":21 } ]
}
```

Offline (device unreachable) returns HTTP 200 with
`{"ok":false,"status":"OFFLINE","error":"miner_unreachable","detail":"..."}`.

### Other routes

| Route | Purpose |
|---|---|
| `GET /api/station-info` | GEODNET station metadata + per-satellite SNR (cloud) |
| `GET /api/health` | Which endpoint is winning + reachability + cloud config state |

---

## Files

```
server.js              backend: polling, fallback chain, tolerant normalizer, signing
public/index.html      front-end: dark-space theme, metric cards, Plotly skyplot, 4s loop
package.json           type: module, express dependency
```

Install once: `npm install`
