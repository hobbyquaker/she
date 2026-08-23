# Roadmap Archive

Completed and closed roadmap items — **one file per item**, named after its ID (e.g. `D1.md`). Open items live in [../../ROADMAP.md](../../ROADMAP.md).

Sections mirror the roadmap categories — Bugs (B), Script Engine (S), Web UI & Editor (U), MQTT, Matter & Broker (M), Integrations (I), Architecture, Operations & Security (A), Testing (T), Documentation (D) — and each section is sorted by number, so a new entry has exactly one correct place.

## Bugs

- [B1 — Logs tab stays empty although scripts are logging ✅ fixed](B1.md)
- [B2 — Cleared retained topics linger in the state store / MQTT tab ✅ fixed](B2.md)
- [B3 — Matter tab shows stale state until reload after freshly pairing a device ✅ fixed](B3.md)
- [B4 — Matter tab attribute-action buttons (Step ▲/▼) do nothing ✅ fixed](B4.md)
- [B5 — she.mqtt.age() intermittently returns NaN ✅ fixed](B5.md)
- [B6 — matter.js logs recurring "FATAL Unhandled error detected: {}" ✅ fixed](B6.md)

## Script Engine

- [S1 — Async callback safety: proper per-dispatch Promise wrapping ✅ implemented](S1.md)

## Web UI & Editor

- [U7 — Hide the log panel when no file is open in the Scripts tab ✅ implemented](U7.md)
- [U8 — Logs tab: clickable script prefix opens the script in the editor ✅ implemented](U8.md)
- [U9 — Log views: show milliseconds in timestamps ✅ implemented](U9.md)
- [U10 — Log views: script-with-line-number errors link to the editor at that line ✅ implemented](U10.md)

## MQTT, Matter & Broker

- [M8 — Rename Matter devices via context menu ✅ implemented](M8.md)
- [M9 — Script start waits for the Matter controller ✅ implemented](M9.md)
- [M10 — Home Assistant discovery cleanup: delete orphaned device announcements ✅ implemented](M10.md)

## Integrations

- [I1 — Expose influx config options in the Config UI ✅ implemented](I1.md)
- [I2 — InfluxDB v1 compatibility ✅ implemented](I2.md)
- [I4 — Services: xyz2mqtt inventory and local host management ✅ implemented](I4.md) — design: [ROADMAP-SERVICES.md](ROADMAP-SERVICES.md)
- [I5 — Services: remote hosts over SSH ✅ implemented](I5.md)
- [I6 — Services: broker.env and per-instance dynsec credentials ✅ implemented](I6.md)
- [I7 — Services: adapter catalog via npm ✅ implemented](I7.md)
- [I9 — Services: remote host bootstrap script ✅ implemented](I9.md)
- [I10 — Services: edit adapter files (map files & co.) ✅ implemented](I10.md)

## Documentation

- [D1 — Document async/await usage and constraints ✅ done](D1.md)
