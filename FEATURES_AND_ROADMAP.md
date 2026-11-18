# Surface Assistant — Features Implemented & Roadmap

This document summarizes everything built so far across **Surface Assistant ("Chill Bedside Nest Hub")** and the remaining work planned to complete full bedside deployment and voice/smart-home integration.

For product requirements, hardware diagnostics, and step-by-step phase execution logs, see:
- [PRD.md](./PRD.md) — Product Requirements Document
- [PLAN.md](./PLAN.md) — Phased Execution Plan
- [TOUCHSCREEN_DEBUG_HANDOFF.md](./TOUCHSCREEN_DEBUG_HANDOFF.md) — Hardware Digitizer & Touch Root-Cause Analysis
- [README.md](./README.md) — Architecture & Developer Quickstart

---

## 1. Platform & Hardware Foundation

- **Target Hardware & OS:** Microsoft Surface Pro 5 (`Surface_Pro_1796`) running **Ubuntu 26.04.1 LTS** with the **`linux-surface` kernel** (`7.3.4-1-surface`), Intel HD Graphics 620 VA-API (`Intel iHD`), **Sway (Wayland)** (`1563×1042` logical @ `1.75` scale), **Brave (`.deb`)**, **Stremio (Flatpak)**, and `iptsd 3.1.1-1`.
- **Lower-Half Touchscreen Adaptation (`y >= 607px`):** Raw `/dev/hidraw2` capacitance diagnostics proved the upper 56.8% of the Surface digitizer (`y = 0..606px`) is dead at the hardware level while `y = 607..1042px` works cleanly. Every interactive control, navigation pill, dialog (`VolumeOSD`), media launcher deck, and Waybar overlay sits strictly inside the working lower half (`y >= 620px`) with `>= 44×44px` touch targets.
- **Cross-Platform Simulation:** Hardware Abstraction Protocols (`AmbientHardwareBackend`, `AudioHardwareBackend`, `CompositorBackend`, `KdeBackend`) automatically select `linux` backends on the Surface and `mock` backends on macOS (`HARDWARE_BACKEND=auto|mock|linux`).

---

## 2. Features Implemented So Far

### A. System, Sway Compositor, PipeWire & Kiosk Recovery (`system/`)
- **Sway Workspace & Window Routing (`system/sway/config`):**
  - Two-workspace architecture: `1:hub` for the Brave Kiosk Hub (`surface-kiosk`) and `2:media` for single-window fullscreen video apps (`surface-media`, `^brave-.*`, case-insensitive `Stremio`).
  - Automatic environment import (`DISPLAY`, `WAYLAND_DISPLAY`, `SWAYSOCK`, `XDG_CURRENT_DESKTOP`, `DBUS_SESSION_BUS_ADDRESS`) into `systemd --user` and D-Bus activation.
  - Physical top-edge volume rocker bindings (`XF86AudioRaiseVolume`, `XF86AudioLowerVolume`, `XF86AudioMute`) wired to `system/scripts/volume-rocker.sh`.
  - Idle inhibition (`inhibit_idle fullscreen`) on `2:media` and `swayidle` screen-awake configuration (`Smart Night Mode` handles backlight dimming).
- **Crash-Proof Kiosk & Blank-Screen Recovery:**
  - `system/scripts/run-kiosk-browser.sh`: `flock`-guarded kiosk supervisor loop that waits for `/api/health`, clears stale `kiosk-profile/Default/Sessions` and `Singleton*` locks, resets `Default/Preferences` (`exit_type: "Normal"`, `popups: 2`), launches Brave in native Wayland `--kiosk` mode (`--disable-features=Vulkan`, `--disable-session-crashed-bubble`, `--noerrdialogs`), and auto-respawns Brave if closed or crashed while Sway is alive.
  - Waybar `exec_always` PID-guarded respawn loop in `system/sway/config` so the overlay pill never permanently disappears.
  - `system/scripts/waybar-home-state.sh` + `system/waybar/config.jsonc` + `system/waybar/style.css`: Bottom-right overlay (`layer: overlay`, `margin-bottom: 20`, `margin-right: 20`) subscribing to Sway `["workspace","window"]` events to show:
    - `⌂ Home` on `2:media` (calls `system/scripts/return-home.sh` -> `POST /api/media/home`, with `playerctl -a pause` + `swaymsg` fallback).
    - `↻ Open Hub` (`#custom-home.recover`) if `surface-kiosk` is missing from the Sway tree (re-focuses `1:hub` and relaunches `run-kiosk-browser.sh`).
    - Hidden (`class: hidden`) during normal Hub usage.
- **Modular PipeWire Virtual Sinks (`system/pipewire-rules/`):**
  - `50-surface-sinks.conf` and `init-sinks.sh` provision independent virtual sinks (`alarm-sink`, `tts-sink`, `media-sink`) so media volume/mute never silences voice TTS or morning alarms.
- **OS Provisioning & Diagnostics (`system/setup-surface.sh`, `system/scripts/`):**
  - Automated installer for `linux-surface` kernel, Sway, Waybar, PipeWire, Brave, Stremio Flatpak (`/usr/local/bin/stremio`), `iptsd` calibration (`system/iptsd/90-touch-calibration.conf`), backlight udev permissions (`system/udev/90-surface-backlight.rules`), `systemd --user` services (`surface-daemon.service`, `surface-wyoming-satellite.service`), GDM/TTY1 autologin (`setup-kiosk-autologin.sh`), and non-destructive system verification (`verify-surface.sh`).

### B. Companion FastAPI + WebSocket Daemon (`daemon/`)
- **Core Server & Live Sync (`daemon/main.py`, `daemon/models.py`, `daemon/config.py`):**
  - FastAPI + WebSocket server on `127.0.0.1:8000` serving the built React `frontend/dist` bundle and typed `/ws` events (`state`, `osd`, `toast`), plus `.env` + `config.yaml` / `config.example.yaml` merging (`${VAR}` substitution).
  - Background polling loops for ambient light (2s), sleep timer countdown/external exit reconciliation (1s), KDE Connect devices (15s), Open-Meteo weather (15m), and wallpaper rotation (configurable, default 2h).
- **Smart Night Mode (`daemon/ambient_light.py`):**
  - Reads IIO ALS lux (`LinuxAmbientBackend`) and writes `/sys/class/backlight/intel_backlight/brightness` with enter/exit lux hysteresis, enter/exit debounce timers, automatic pause while active video is playing (`pause_during_video`), and manual override (`/api/night-mode`).
- **Independent 3-Channel Audio (`daemon/audio_control.py`):**
  - `PipeWireAudioBackend` (`pactl`) and `AudioService` managing `alarm`, `tts`, and `media` sink levels (`0–150%`) and mute states (`/api/audio/level`, `/api/audio/rocker` ±5% step with live `osd` WebSocket trigger).
- **Single-Window Media Launcher & Sleep Timer (`daemon/media_launcher.py`):**
  - Supports browser tiles (`YouTube`, `Netflix`, `Prime Video`, `Anime` via `${ANIME_PORTAL_URL}`) and native `Stremio` (`POST /api/media/launch`, `/api/media/home`, `/api/media/close`).
  - Launches browser media tiles in native Wayland `--kiosk` mode with `--disable-features=Vulkan` and `VaapiVideoDecodeLinuxGL`, prepares `media-profile` cleanly before launch (`Sessions` wipe, `exit_type: "Normal"`, `popups: 2`, `brave.widevine_opted_in: true` in `Local State`), resolves D-Bus/XDG/Flatpak environment variables, kills full process groups (`os.killpg` + `flatpak kill com.stremio.Stremio`) before switching tiles or closing orphaned `2:media` windows, focuses `2:media` only after launch succeeds, watches exited/empty workspaces (`> 5s` grace + `workspace_has_windows`), and broadcasts state updates over `/ws`.
  - Sleep Timer (`POST /api/sleep-timer`): countdown pauses MPRIS (`playerctl -a pause`), closes `2:media`, returns focus to `1:hub`, and forces Night Mode on expiry.
- **Shuffled Local Wallpapers (`daemon/wallpapers.py`):**
  - Discovers local images and looping `.mp4` videos (`~/wallpapers/static`, `~/wallpapers/loops`, `~/wallpapers`, falling back to bundled `daemon/assets/wallpapers/`), shuffles playlists without back-to-back repeats across wraps, enforces path-traversal-safe file serving, and exposes `/api/wallpapers/next`, `/api/wallpapers/refresh`, and `/api/wallpapers/file/{item_id}`.
- **KDE Connect & Knowledge Services (`daemon/kde_bridge.py`, `daemon/knowledge.py`):**
  - Matches `PRIMARY_PHONE_NAME` (`Google Pixel 10 Pro`) via `kdeconnect-cli` + `gdbus` for battery/charging telemetry, outbound SMS (`/api/kde/sms`), and incoming WhatsApp notification replies (`/api/kde/reply`).
  - Fetches current weather from Open-Meteo and answers general queries via Wikipedia REST Summary with DuckDuckGo Instant Answer fallback (`/api/knowledge/query`).
- **Hardware Simulator (`daemon/simulator.py`):**
  - Mounted only in `mock` mode: `/sim` SPA route plus `/api/sim/lux`, `/api/sim/sleep-expire`, and `/api/sim/device`.

### C. 3-Pane Bedside Kiosk UI (`frontend/`)
- **Root Shell & Touch Physics (`frontend/src/App.tsx`, `frontend/src/index.css`, `frontend/index.html`):**
  - GPU-accelerated 3-pane horizontal slider (`Smart Home` ◄── `Ambient Hub` ──► `Bedside Theater`) with pointer capture filtering (`event.target !== event.currentTarget`), `touch-action: none` layering, `inert` management on off-screen panes, keyboard arrow navigation, inline SVG favicon, and persistent `Notifications` region (`aria-live="polite"` / `aria-live="assertive"`).
- **Pane 1 — Ambient Hub (`frontend/src/components/AmbientHubPane.tsx`, `DevicePill.tsx`):**
  - Edge-to-edge crossfading image/MP4 wallpaper canvas, minimalist `12h`/`24h` clock, date, `°C`/`°F` weather badge, Night Mode (black background + dim amber clock with tap-to-peek 8s reveal), sleep timer preset menu (`15m`/`30m`/`45m`/`60m`/`Off` + live countdown badge), Next Wallpaper, Volume Mixer trigger, and expandable `DevicePill` showing KDE Connect battery/charging status.
- **Pane 2 — Smart Home Controls (`frontend/src/components/SmartHomePane.tsx`, `frontend/src/services/haSocket.ts`):**
  - Home Assistant WebSocket client (`auth` + `get_states` + `subscribe_events` + `call_service`) with normalized URL/token validation and automatic offline fallback (`PLACEHOLDER_HA_ENTITIES`) when unconfigured.
  - Lower-half 3-column control deck for one-tap Scenes (`Relax`, `Movie`, `Goodnight`), Bedroom Lighting (main toggle, brightness slider, bedside lamp), Climate / AC (`18–30°C` +/- & `Cool`/`Dry`/`Fan`/`Eco` modes), and Smart Plugs (`Desk Plug`, `Standing Fan`).
- **Pane 3 — Bedside Theater (`frontend/src/components/MediaLauncher.tsx`, `mediaDialMath.ts`, `MediaBrandLogos.tsx`, `dialAudio.ts`):**
  - Upper non-interactive brand hologram projection stage paired with a lower-half orbital rotary dial: modular wrap-around geometry, magnetic detent curve, flick velocity coasting + touch-to-brake, dual drag thresholds (`22px` on medallions vs `6px` on scrub ring), synthesized Web Audio rotary/detent clicks unlocked only on user gesture, 2-tap preview vs 1-tap launch, off-center micro-labels, concurrent launch lock (`launchingTileRef`), live `"Now Playing"` / `"Resume"` indicators, lower-deck `"Close <App>"` control (`POST /api/media/close`), and real `DaemonApiError` toast feedback.
- **Volume OSD & Mac Simulator (`frontend/src/components/VolumeOSD.tsx`, `SimulatorConsole.tsx`, `daemonSocket.ts`):**
  - Bottom-aligned 3-channel audio mixer dialog triggered manually or live via `/ws` `osd` events (auto-closing after 5s on hardware rocker pushes).
  - `/sim` developer console to simulate lux changes, device battery/charging, rocker presses, Waybar Home Pill, `Close Media`, sleep timer expiry, SMS/WhatsApp replies, and knowledge queries.

### D. Home Assistant & Voice Scaffolding (`homeassistant/`, `docker-compose.yml`)
- Docker Compose stack for `homeassistant` (host networking, `1024m`), `wyoming-whisper` (`base.en` `int8`, `768m`), `wyoming-piper` (`en_US-lessac-medium`, `512m`), and `wyoming-openwakeword` (`hey_jarvis`, `384m`).
- Declarative HA config (`configuration.yaml`, `scenes.yaml`, `intent_script.yaml`, `custom_sentences/en/surface_assistant.yaml`) wiring 9 voice intents (`SurfaceOpenMedia`, `SurfaceReturnHome`, `SurfaceNextWallpaper`, `SurfaceNightModeOn/Off`, `SurfaceSleepTimer`, `SurfaceCancelSleepTimer`, `SurfaceSendSms`, `SurfaceReplyWhatsApp`) and `rest_command` bridges to the daemon.
- Custom HA Conversation Agent (`homeassistant/custom_components/surface_knowledge/`) routing general knowledge questions to the daemon's `/api/knowledge/query` endpoint.

### E. Developer Tooling & Automated QA Suites (`scripts/`, `daemon/tests/`, `frontend/src/__tests__/`)
- **Workflow Scripts (`scripts/`):** `simulate-mac.sh` (local Mac dev bootstrap + live mock server), `deploy-surface.sh` (`rsync` over SSH with `--sync-system`, `--sync-wallpapers`, `--restart`, `--dry-run`), and `sync-wallpapers.sh`.
- **Automated Verification Currently Passing:**
  - **Python (`pytest` — 95 tests):** Daemon API, Night Mode/PipeWire audio, Media Launcher/Sway IPC/Wallpapers/Knowledge/Config, KDE Connect, Simulator gating, Home Assistant YAML + custom component tests (with stubbed HA modules), and 49 isolated mocked-CLI shell script tests (`test_system_scripts.py`).
  - **Python Static Checks:** `mypy daemon` (strict, 18 files) and `ruff check daemon homeassistant`.
  - **Frontend (`vitest` — 55 tests + `tsc` + `vite build`):** Dial math, Web Audio synth, `daemonSocket`, `haSocket`, all panes/components, `SimulatorConsole`, and touch/pointer gesture regressions.
  - **Live Browser E2E (Headless Google Chrome CDP against live `uvicorn`):** Verified HTTP + `/ws` handshake, `1563×1042` lower-half geometry (`top >= 664.0px`, `>= 44×44px` touch targets), 3-pane flows, Stremio/Anime/YouTube/Netflix dial & close flows, simulated 500 error toast, `/sim`, and zero unexpected console/network errors.

---

## 3. Planned Work & Roadmap (What We Are Planning To Do)

### Immediate Step — Deploy & Verify Latest Fixes on Surface Pro 5
- [ ] Sync latest `fix/touchscreen` changes to the tablet (`./scripts/deploy-surface.sh --sync-system --restart`) and run `bash ~/Surface_assistant/system/scripts/verify-surface.sh`.
- [ ] Confirm on live hardware (`192.168.0.100`):
  - Brave `media-profile` Widevine playback on Netflix/Prime Video and hardware-accelerated YouTube playback without gray screens.
  - Anime portal opens locked in `--kiosk` without popups or exiting fullscreen, and switching between Anime and Stremio cleanly closes the previous app.
  - Closing any window or killing Brave either auto-respawns `surface-kiosk` or surfaces Waybar's bottom-right `⌂ Home` / `↻ Open Hub` recovery pill.
- [ ] Propose/finalize atomic commits on `fix/touchscreen` and merge back to `main`.

### Phase 3 — Alarms, Missing Voice Intents & Voice Stack Bring-Up (`PLAN.md`)
- [ ] **Alarm & Countdown Timer Scheduler (`daemon/`):** Implement in-memory/persistent alarm scheduling with API + `/ws` events and audio playback routed explicitly to `alarm-sink` (`paplay`/`pw-play`), supporting snooze and dismiss via voice or UI.
- [ ] **Expanded Voice Intents & Geocoded Weather (`homeassistant/`, `daemon/`):**
  - Add intents for setting/querying/snoozing/stopping alarms and timers, switching UI panes (`Smart Home`, `Ambient Hub`, `Media`), and media playback pause/resume (`playerctl`).
  - Update `daemon/knowledge.py` to geocode city names via Open-Meteo for weather queries mentioning another location.
- [ ] **Wake-Word Listening UI Hook:** Expose `listening: bool` state from the Wyoming satellite/daemon so the hub shows a subtle listening dot and wakes dimmed Night Mode controls when the wake word fires.
- [ ] **Docker Voice Stack Bring-Up:** Start `docker compose up -d` (`homeassistant`, `wyoming-whisper`, `wyoming-piper`, `wyoming-openwakeword`) + `surface-wyoming-satellite.service`, complete HA onboarding, configure `HA_TOKEN` on Surface `.env`, and verify total idle RAM stays `< 3.5 GB`.

### Phase 4 — Frontend Kiosk UI Polish (`PLAN.md` + QA Findings)
- [ ] **Night Mode Auto-Resume (`AmbientHubPane.tsx`):** Allow toggling Night Mode back to `null` (automatic ambient lux control) instead of locking to manual `true`/`false`, and render the wake-word listening indicator.
- [ ] **OSD Timer Reset & Slider Alignment (`App.tsx`, `VolumeOSD.tsx`):** Reset the 5s auto-dismiss timer when adjusting sliders during hardware-triggered OSD rather than cancelling it, and align UI slider bounds (`0–100%` vs `0–150%`) with PipeWire sink policy.
- [ ] **Offline Scenes & Simulator Resilience (`haSocket.ts`, `SimulatorConsole.tsx`, `homeassistant/`):**
  - Add `scene.*` state transitions in `PLACEHOLDER_HA_ENTITIES` so `Relax`/`Movie`/`Goodnight` visibly update lights/AC/plugs in offline demo mode.
  - Add `.catch()` error handling to the remaining fire-and-forget click handlers in `SimulatorConsole.tsx` so unreachable daemon calls don't emit unhandled promise rejections.
  - Add `surface_close_media` `rest_command` in `homeassistant/configuration.yaml` if voice intents distinguish pause/return-home vs full media close.
- [ ] **Media Return UX Polish:** Evaluate Sway touch edge-swipe gestures alongside the bottom-right Waybar `⌂ Home` pill.

### Phase 5 — Final Hardware & Bedside Acceptance (`PLAN.md`)
- [ ] **KDE Connect Multi-Device Pairing:** Pair **Google Pixel 10 Pro** (Primary), **Nothing Phone 1**, and **Main Laptop** on Surface Wi-Fi; verify `DevicePill` battery telemetry, voice-triggered outbound SMS, and WhatsApp notification replies (plus research initiating new WhatsApp threads as a stretch goal).
- [ ] **End-to-End Bedside Acceptance Sign-Off:** Verify UEFI 50% battery limit, `< 3.5 GB` idle RAM, smooth 1080p VA-API playback, independent `media-sink` rocker vs `tts-sink`/`alarm-sink`, full room-lights-off Night Mode cycle, and Sleep Timer auto-shutdown.
