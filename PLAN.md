# Execution Plan — Project "Chill Bedside Nest Hub" (`Surface_assistant`)

> **How to use this file in a fresh context:** Read `PRD.md` and this `PLAN.md`, check which Phase is next (`[ ]`), execute only that Phase incrementally with checkpoints, update the checkboxes in `PLAN.md`, and propose an atomic git commit before ending.

---

## Live Environment & Hardware Facts (Verified)

- **Mac Repo Root:** `/Users/kaushik/Projects/surface_pro` (`main` → `https://github.com/akkolluru/Surface_assistant.git`)
- **Surface Pro 5 SSH Target:** `time-master@192.168.0.100` (passwordless ED25519 key `mac-to-surface` verified; `sudo` requires interactive password)
- **Surface OS & Kernel:** **Ubuntu 26.04.1 LTS (Resolute Raccoon)**, stock kernel `7.0.0-30-generic`, **Secure Boot enabled**
- **Surface Hardware Paths:**
  - Ambient Light Sensor: `/sys/bus/iio/devices/iio:device0` (`name: als`, `in_illuminance_raw`, `in_illuminance_scale: 0.001`)
  - Backlight: `/sys/class/backlight/intel_backlight` (`max_brightness: 7500`)
  - Audio: `HDA Intel PCH` (`ALC298 Analog`), `pipewire` + `wpctl` installed
- **Devices (KDE Connect):**
  - Primary Phone (SMS & WhatsApp): **Google Pixel 10 Pro**
  - Secondary Handheld: **Nothing Phone 1**
  - Laptop: **Main Laptop**
- **Pending User Decisions (keep configurable, do not hardcode):**
  - Final wake word (currently defaults to `hey_jarvis` in `config.example.yaml`)
  - `ANIME_PORTAL_URL` (currently placeholder `https://example.com` in `.env.example`)
  - Initiating brand-new WhatsApp messages via KDE Connect (outbound SMS + replying to incoming WhatsApp notifications are baseline scope; new WhatsApp threads are stretch/research)

---

## Phase 1 — Repo Polish, Primary Phone & Deploy Script *(Mac)*
**Status:** `[x] Complete` (Branch: `phase-1`)

### Tasks
1. **Fix HA custom component lint error:**
   - [x] Remove unused `from . import DOMAIN` in `homeassistant/custom_components/surface_knowledge/conversation.py` (line 15).
2. **Pin Primary Phone (`Google Pixel 10 Pro`):**
   - [x] Add `PRIMARY_PHONE_NAME=Google Pixel 10 Pro` to `.env.example` (and `.env` if present) and `kde_connect.primary_phone_name` (or matching setting) in `config.example.yaml` / `daemon/config.py`.
   - [x] Update `daemon/kde_bridge.py` (`_find_phone_id()`) to prefer the configured `primary_phone_name` (case-insensitive substring/exact match) before falling back to the first reachable phone, and add unit tests in `daemon/tests/`.
3. **Add Mac → Surface Deploy Script:**
   - [x] Create `scripts/deploy-surface.sh` (`rsync` over SSH excluding `.git`, `.venv`, `node_modules`, `.env`, `config.yaml`, caches) targeting `time-master@192.168.0.100:~/Surface_assistant` (configurable via env vars `SURFACE_HOST`, `SURFACE_USER`, `SURFACE_DIR`), with `--restart` flag support for `surface-daemon.service`.
4. **Update stale docs:**
   - [x] Refresh `README.md` baseline wording where needed.

### Verification Checkpoint
- [x] `.venv/bin/pytest` (18/18 daemon tests pass, including 7 new primary-phone tests in `daemon/tests/test_kde_bridge.py`)
- [x] `.venv/bin/mypy daemon` (0 issues)
- [x] `.venv/bin/ruff check daemon homeassistant` (0 issues)
- [x] `bash -n scripts/deploy-surface.sh`
- [x] Atomic commits created on `phase-1` branch and pushed to GitHub.

---

## Phase 2 — Surface Pro 5 OS, Sway Kiosk & Audio Bring-Up *(Mac → Surface)*
**Status:** `[~] In Progress (Mac/repo changes complete; Surface SSH & MOK verification pending)`

### Tasks
1. **Fix Sway ↔ `systemd --user` & Media Window Rules (on Mac):**
   - [x] Update `system/sway/config` to export Wayland/D-Bus env vars into `systemd --user`:
     `exec systemctl --user import-environment WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP DBUS_SESSION_BUS_ADDRESS` (plus guarded `dbus-update-activation-environment --systemd` and `SwayCompositorBackend` socket fallback in `daemon/media_launcher.py`).
   - [x] Add `for_window [app_id="surface-media"] move to workspace "2:media", fullscreen enable` and `for_window [class="surface-media"] move to workspace "2:media", fullscreen enable` (plus `[class="surface-kiosk"]` rules).
   - [x] Update `system/setup-surface.sh` for Ubuntu 24.04/26.04 compatibility (`docker.io` / `docker-ce` & `docker-compose-v2` / `docker-compose-plugin` check, Stremio Flatpak + `/usr/local/bin/stremio` wrapper, `loginctl enable-linger`, and `~/Surface_assistant` path consistency with `system/systemd/surface-daemon.service`).
   - [x] Add `system/scripts/setup-kiosk-autologin.sh` (TTY1 `getty@tty1` autologin + guarded Sway launch) and `system/scripts/verify-surface.sh` (Phase 2 hardware/audio/service verification).
2. **Sync Repo to Surface:**
   - [ ] Run `./scripts/deploy-surface.sh` from Mac to populate `~/Surface_assistant` on `192.168.0.100`.
3. **User Manual Step on Surface (requires `sudo` + MOK reboot):**
   - [ ] Run `bash ~/Surface_assistant/system/setup-surface.sh` (or with `--with-autologin`) on the Surface, set the Secure Boot MOK enrollment password when prompted, reboot, and enroll the MOK key at the blue MokManager screen.
   - [ ] Verify UEFI **Enable Battery Limit Mode** (50% cap) is ON in Surface UEFI if not already set.
4. **Configure Kiosk Autologin & Verify Hardware (via SSH):**
   - [ ] Run `bash ~/Surface_assistant/system/scripts/setup-kiosk-autologin.sh` (if not passed via `--with-autologin`) and `bash ~/Surface_assistant/system/scripts/verify-surface.sh`.

### Verification Checkpoint (over SSH on Surface)
- `uname -r` shows `-surface` kernel; `vainfo` confirms Intel HD 620 VA-API decoding.
- `cat /sys/bus/iio/devices/iio:device0/in_illuminance_raw` reads live lux; backlight write permission (`video` group + udev rule) works without sudo.
- `pactl list short sinks` shows `alarm-sink`, `tts-sink`, and `media-sink` independently adjustable via `wpctl`/`pactl`.
- `curl http://127.0.0.1:8000/api/health` responds on Surface, and Brave kiosk opens on Sway `1:hub`.

---

## Phase 3 — Alarms, Missing Voice Intents & Backend Brain *(Daemon + Home Assistant + Docker)*
**Status:** `[ ] Not Started`

### Tasks
1. **Alarm Scheduler & `alarm-sink` Playback (`daemon/`):**
   - Implement persistent/in-memory alarm & countdown timer scheduler in `daemon/` (`models.py`, new `alarms.py` or service module, API endpoints + WebSocket broadcast).
   - Play alarm audio explicitly routed to PipeWire `alarm-sink` (`paplay`/`pw-play` or bundled/generated tone) with voice/UI **snooze** and **stop/dismiss** actions.
2. **Missing Voice Intents & Knowledge Improvements (`homeassistant/`, `daemon/`):**
   - Add intents in `homeassistant/custom_sentences/en/surface_assistant.yaml` and `homeassistant/intent_script.yaml` for:
     - Alarms & timers (*set alarm, query alarms, snooze, stop alarms, set/cancel timer*)
     - UI pane switching (*switch to smart home / hub / media*)
     - Media playback control (*pause / resume* via `playerctl`)
   - Improve `daemon/knowledge.py` so weather queries with a city name resolve geocoding via Open-Meteo instead of always falling back to fixed `.env` coordinates.
3. **Wake-Word UI Hook:**
   - Expose wake-word listening state (`listening: bool`) via daemon state/WebSocket (triggered by Wyoming/satellite hook or endpoint) so the UI displays the listening dot and wakes dim Night Mode controls.
4. **Home Assistant + Wyoming Bring-Up (Surface):**
   - Start `docker compose up -d` (`homeassistant`, `wyoming-whisper`, `wyoming-piper`, `wyoming-openwakeword`) and `surface-wyoming-satellite.service`.
   - Complete HA onboarding/Wyoming integration wiring (`surface_knowledge` conversation agent + long-lived `HA_TOKEN` in Surface `.env`).

### Verification Checkpoint
- Mac: `pytest`, `mypy daemon`, `ruff check daemon homeassistant`, YAML validation.
- Surface (SSH + User voice test): Say wake word, set & stop an alarm (verify `alarm-sink` plays even if `media-sink` is muted/low), ask a weather/Wiki question, and verify total idle RAM < **3.5 GB** (`free -m`).

---

## Phase 4 — Frontend Kiosk UI Polish *(React + TypeScript + Vite)*
**Status:** `[ ] Not Started`

### Tasks
1. **`AmbientHubPane.tsx` Night Mode & Wake-Word Dot:**
   - Update Night Mode button (`AmbientHubPane.tsx:253`) to support cycling/returning to `null` (resume automatic ambient lux control) instead of staying locked to manual `true`/`false`.
   - Render subtle wake-word listening indicator dot and temporarily reveal dim controls when wake-word triggers in Night Mode.
2. **`VolumeOSD.tsx` & `App.tsx`:**
   - Fix `App.tsx:156` so interacting with sliders resets the 5s auto-dismiss timer rather than cancelling it permanently.
   - Align slider range/labels cleanly with backend sink limits (`0–100%` or `0–150%` consistently) and polish touch ergonomics.
3. **`haSocket.ts` & `SmartHomePane.tsx`:**
   - Add exponential reconnect backoff when HA WebSocket disconnects.
   - Add `scene.*` placeholder entities to `PLACEHOLDER_HA_ENTITIES` so tapping Scenes works cleanly in offline/placeholder mode.
4. **Media State Sync (`daemon/media_launcher.py` & `MediaLauncher.tsx`):**
   - Clear `active_tile_id` if an externally launched video window (`2:media`) is closed by the user or exits.
   - Polish `"⌂ Home"` return experience (and evaluate Sway touch edge-swipe if supported cleanly alongside Waybar pill).

### Verification Checkpoint
- Mac: `cd frontend && npm run typecheck && npm test && npm run build`.
- Surface: Deploy via `./scripts/deploy-surface.sh --restart` and verify touch swipes, Night Mode auto-resume, OSD auto-dismiss, and offline Scenes on the 12.3" touchscreen.

---

## Phase 5 — Final Hardware & Bedside Integration Verification *(Surface + Phones)*
**Status:** `[ ] Not Started`

### Tasks
1. **KDE Connect Multi-Device Pairing:**
   - Pair **Google Pixel 10 Pro** (Primary), **Nothing Phone 1**, and **Main Laptop** over local Wi-Fi.
   - Verify `DevicePill` collapsed/expanded battery & charging states, voice-triggered outbound SMS via Pixel 10 Pro, and quick replies to incoming WhatsApp notifications. *(Investigate initiating new WhatsApp messages as stretch goal.)*
2. **Full Bedside Acceptance Checklist (PRD §3 & §4):**
   - [ ] UEFI 50% Battery Limit Mode active (`BAT1` capped around 50% while plugged in).
   - [ ] Idle RAM < 3.5 GB; smooth 1080p playback in YouTube/Netflix/Prime/Stremio via Intel VA-API.
   - [ ] Physical volume rockers control only `media-sink` and trigger `VolumeOSD` with independent `Media`, `Voice`, and `Alarms` sliders.
   - [ ] Room lights off (`als` < threshold) → wallpaper fades to `#000000`, dim amber clock only, `intel_backlight` drops to minimum; tap/wake-word reveals dim controls; lights on restores Hub.
   - [ ] Sleep Timer expiry pauses `playerctl`, closes `2:media`, returns to `1:hub`, and forces Smart Night Mode.
