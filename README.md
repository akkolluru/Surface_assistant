# Surface Assistant — Chill Bedside Nest Hub

A zero-cost, privacy-first **Bedside Smart Hub & Ambient Media Display** for a detached-keyboard **Microsoft Surface Pro 5 (2017)** running **Ubuntu 24.04 / 26.04 LTS + `linux-surface`** (verified target: **Ubuntu 26.04 LTS**).

See [PRD.md](./PRD.md) for product requirements and behavior specs.

## Architecture Summary

- **OS & Compositor:** Ubuntu 24.04 / 26.04 LTS (verified target: Ubuntu 26.04 LTS) + `linux-surface` kernel + **Sway (Wayland)** with `swaymsg` JSON IPC (Workspace 1 = Kiosk Hub, Workspace 2 = Single Active Video App) + `wlr-layer-shell` Home pill & `swayosd` video volume overlay.
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
├── docker-compose.yml        # Home Assistant + Wyoming voice servers
├── scripts/                  # Mac local simulation & Surface SSH deploy scripts
├── system/                   # Ubuntu setup, Sway config, PipeWire rules, systemd units
├── homeassistant/            # Declarative HA config & custom sentences
├── daemon/                   # Python FastAPI hardware daemon + pytest suite
└── frontend/                 # React + strict TS 3-pane kiosk UI + Vitest suite
```

## Local Development (macOS / Linux)

The Python daemon uses Hardware Abstraction Protocols with automatic `mock` backends on macOS so every component, WebSocket contract, and test suite runs locally without Surface hardware.

1. **Configure:** Copy `.env.example` to `.env` and `config.example.yaml` to `config.yaml`. Set environment overrides as needed (including `PRIMARY_PHONE_NAME` for KDE Connect primary phone matching, `HA_TOKEN`, and `ANIME_PORTAL_URL`).
2. **Mac Local Simulation:** Run `./scripts/simulate-mac.sh` (pass `--no-open` to skip opening browser tabs) to bootstrap `.venv`, build the frontend bundle, and launch the daemon with `HARDWARE_BACKEND=mock`:
   - Kiosk Hub UI: `http://127.0.0.1:8000`
   - Hardware Simulator: `http://127.0.0.1:8000/sim`
3. **Tests & Checks:**
   - Python daemon & HA custom component:
     ```bash
     .venv/bin/pytest
     .venv/bin/mypy daemon
     .venv/bin/ruff check daemon homeassistant
     ```
   - Frontend:
     ```bash
     cd frontend
     npm run typecheck
     npm test
     npm run build
     ```
4. **Deploy Mac → Surface:** Sync changes to the Surface Pro 5 over SSH (defaults to `time-master@192.168.0.100:~/Surface_assistant`, configurable via `SURFACE_USER`, `SURFACE_HOST`, and `SURFACE_DIR`; excludes local `.env`, `config.yaml`, caches, and runtime data):
   ```bash
   ./scripts/deploy-surface.sh [--restart]
   ```
   Pass `--restart` to run `systemctl --user restart surface-daemon.service` after syncing, or `--dry-run` to preview the sync without making changes.
