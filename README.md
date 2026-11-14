# Surface Assistant — Chill Bedside Nest Hub

A zero-cost, privacy-first **Bedside Smart Hub & Ambient Media Display** for a detached-keyboard **Microsoft Surface Pro 5 (2017)** running **Ubuntu 24.04 LTS + `linux-surface`**.

See [PRD.md](./PRD.md) for product requirements and behavior specs.

## Architecture Summary

- **OS & Compositor:** Ubuntu 24.04 LTS + `linux-surface` kernel + **Sway (Wayland)** with `swaymsg` JSON IPC (Workspace 1 = Kiosk Hub, Workspace 2 = Single Active Video App) + `wlr-layer-shell` Home pill & `swayosd` video volume overlay.
- **Browser & Media:** **Brave (`.deb`)** for the Kiosk UI and `--app` tiles (Widevine DRM, Intel VA-API, built-in adblocking) + native **Stremio**.
- **Backend Brain (Docker):** Home Assistant Core + Wyoming `openWakeWord` (`hey_jarvis`), `Faster-Whisper` (`base.en` `int8`), and `Piper` TTS.
- **Voice Audio Satellite (Host):** `wyoming-satellite` systemd user service capturing dual-array mics and routing TTS/Alarms natively into PipeWire virtual sinks (`tts-sink`, `alarm-sink`, `media-sink`).
- **System Companion Daemon:** Strictly typed Python FastAPI + WebSocket service on `127.0.0.1:8000` serving the production React `dist/` bundle, managing IIO lux Smart Night Mode, Sway/MPRIS video lifecycle, KDE Connect battery/SMS/WhatsApp quick-replies, and free Wikipedia/DuckDuckGo/Open-Meteo fallbacks.
- **Kiosk Frontend:** Vite + React + strict TypeScript + Tailwind CSS + Framer Motion 3-pane touch UI (`Smart Home` ◄── `Ambient Hub` ──► `Video Launcher`).

## Repository Layout

```text
.
├── PRD.md                    # Product Requirements Document
├── config.example.yaml       # Copy to config.yaml (gitignored)
├── .env.example              # Copy to .env (gitignored)
├── docker-compose.yml        # Home Assistant + Wyoming voice servers (upcoming)
├── system/                   # Ubuntu setup, Sway config, PipeWire rules, systemd units
├── homeassistant/            # Declarative HA config & custom sentences
├── daemon/                   # Python FastAPI hardware daemon + pytest suite
└── frontend/                 # React + strict TS 3-pane kiosk UI + Vitest suite
```

## Local Development (macOS / Linux)

The Python daemon uses Hardware Abstraction Protocols with automatic `mock` backends on macOS so every component, WebSocket contract, and test suite runs locally without Surface hardware.

1. Copy `.env.example` to `.env` and `config.example.yaml` to `config.yaml`.
2. (Incremental chunks will populate `system/`, `docker-compose.yml`, `homeassistant/`, `daemon/`, and `frontend/`.)
