# Product Requirements Document (PRD): Project "Chill Bedside Nest Hub"

**Version:** 1.0

**Status:** Finalized Blueprint (Ready for Repo Setup & Implementation)

**Target Environment:** Google Antigravity IDE / Linux Development Workflow

**Hardware Target:** Microsoft Surface Pro 5 (2017) — Intel Core i5-7300U (Fanless), 8 GB RAM, 256 GB (238 GB usable) SSD, 12.3" 2736×1824 PixelSense Touchscreen

---

## 1. Executive Summary & Core Vision

Transform a detached-keyboard Microsoft Surface Pro 5 into a dedicated, zero-cost, privacy-first **Bedside Smart Hub & Ambient Media Display** running pure Linux.

The system replaces Windows entirely and operates as an appliance-grade, 3-pane touch-first interface. It serves as an ambient art/wallpaper display and ultra-dim night clock by default, integrates a 100% free local-first voice assistant with web-grounded general knowledge and Android messaging bridges, provides a centralized smart-home control panel (ready for future multi-brand hardware), and swipes effortlessly into a full-screen bedside media launcher.

### Non-Negotiable Constraints

* **$0 Operational & Hardware Cost:** No paid LLM APIs (OpenAI/Gemini), no cloud subscriptions, no extra peripherals required (uses built-in stereo speakers, dual microphones, ambient light sensor, and kickstand).
* **Zero Local LLMs:** Do not run local generative LLMs (too heavy for i5-7300U / 8 GB RAM). Use deterministic intent matching + free REST APIs for general queries.
* **No Windows:** Complete bare-metal Linux installation with the `linux-surface` kernel.
* **Bedside Ergonomics:** Placed on the **left side of the bed**. Silent operation (fanless), dark-room safe at night, and touch-first navigation without needing a mouse or keyboard.

---

## 2. System Architecture & Tech Stack

The system uses **Path B (Decoupled Headless Backend + Bespoke Custom Frontend)** to achieve native, 60fps glassmorphism animations and spatial swipe physics without low-code dashboard limitations.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CUSTOM FRONTEND (KIOSK UI)                       │
│   Vite + React + TypeScript + Tailwind CSS (Chromium Kiosk Window)      │
│   [ Left: Smart Controls ] ◄──► [ Center: Ambient Hub ] ◄──► [ Right: Media ] │
└───────────────────┬─────────────────────────────────┬───────────────────┘
                    │ WebSocket (ws://localhost:8123) │ Local IPC / HTTP
                    ▼                                 ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────┐
│      BACKEND BRAIN (DOCKER)           │ │   LINUX SYSTEM DAEMON (PY/JS) │
│  • Home Assistant Core                │ │  • PipeWire Modular Volume    │
│  • openWakeWord (Always-On Listening) │ │  • IIO Ambient Light Reader   │
│  • Faster-Whisper (tiny/base STT)     │ │  • Window/App Launcher        │
│  • Piper TTS (Local Voice Output)     │ │  • KDE Connect CLI Bridge     │
│  • Free REST Sensors (Wiki/DDG/Meteo) │ │  • Sleep Timer Controller     │
└───────────────────────────────────────┘ └───────────────────────────────┘
                    ▲
                    │ Local Wi-Fi (Zero Cloud)
┌───────────────────┴─────────────────────────────────────────────────────┐
│                     OS & HARDWARE LAYER (LINUX)                         │
│  Ubuntu 24.04 LTS + linux-surface Kernel + Wayland Kiosk Compositor     │
│  PipeWire Virtual Sinks + UEFI Battery Limit Mode (50% Charge Cap)      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

1. **OS, Kernel & Compositor:** Ubuntu 24.04 LTS + `linux-surface` kernel + dedicated Wayland kiosk compositor (`labwc` or `sway`, 150%–200% fractional scaling) for deterministic window management and touch-edge gestures.
2. **Backend Engine:** Home Assistant Core (Docker) handling state management, entity normalization, timers/alarms, and the local **Assist** voice pipeline.
3. **Voice Pipeline (100% Free & Local):**
   * Wake Word: `openWakeWord` (wake word selection TBD / pending decision).
   * STT: `Faster-Whisper` (`tiny` or `base` quantized CPU model).
   * Intent Engine: Home Assistant built-in intents + custom RESTful/shell intent scripts.
   * TTS: `Piper` (local neural TTS).
4. **Device Bridge:** `KDE Connect` running over local Wi-Fi connecting the Surface Pro 5 to the user's primary Android phone, Nothing Phone 1 (gaming handheld), and main laptop.
5. **Custom Frontend:** Single-Page Web Application (**React + TypeScript + Vite + Tailwind CSS + Framer Motion / `@use-gesture`**) running in a frameless, hardware-accelerated Chromium kiosk window.
6. **System Companion Daemon:** Lightweight Python (`FastAPI` or `websockets`) service exposing OS-level hardware hooks (ambient light sensor, PipeWire audio streams, Wayland compositor window switching, sleep timer execution) to the frontend.

---

## 3. Functional Requirements

### 3.1 Spatial 3-Pane User Interface

The UI consists of three horizontal full-screen panes (`100vw × 100vh`) navigated via smooth touch swipe gestures (optimized for left-of-bed placement):

#### Pane 1 (Center / Default Home): Ambient Hub & Clock

* **Edge-to-Edge Media Canvas:** Full-bleed background cycling smoothly (with crossfade transitions) through a local directory (`/home/<user>/wallpapers`) containing curated static high-res images (pixel art, anime art, game art) and looping `.mp4` animations.
* **Primary Typography:** Minimalist, high-legibility digital clock, date, and current local weather (Hyderabad, via free Open-Meteo API) positioned so focal points of background art remain unobstructed.
* **Tap-to-Expand Glassmorphism Device Pill:**
  * *Collapsed State (Default):* A compact, low-profile translucent glass pill displaying small icons for connected devices (**Primary Phone**, **Nothing Phone 1**, **Main Laptop**).
  * *Expanded State (On Tap):* Smoothly animates open to reveal exact battery percentages, charging indicators, and connection statuses synced via KDE Connect. Tapping outside or after an inactivity timeout smoothly collapses it back.
* **Minimalist Quick Controls:**
  * **Next Wallpaper Button:** Subtle glass icon button to immediately advance to the next wallpaper/MP4 loop.
  * **Sleep Timer Control:** Quick-tap timer selector (`15m`, `30m`, `45m`, `60m`, `Off`) with subtle countdown badge when active.

#### Pane 2 (Left Pane — Swipe Left-to-Right `→`): Centralized Smart Home Control Panel

* **Purpose:** Brand-agnostic control hub powered by Home Assistant entities so future smart devices (Wi-Fi/Zigbee/Matter bulbs, plugs, IR blasters) integrate into one UI without vendor apps.
* **Initial State (Placeholder Architecture):** Renders sleek, dark-glass interactive placeholder cards (*Bedroom Lighting*, *Climate / AC*, *Smart Plugs*, *Scenes*) bound to mock/template Home Assistant entities, allowing immediate UI verification and seamless drop-in replacement when physical hardware is added later.

#### Pane 3 (Right Pane — Swipe Right-to-Left `←`): Bedside Video Launcher

* **Layout:** Oversized, high-contrast, touch-friendly app tiles designed for effortless tapping from bed.
* **Required Tiles & Launch Targets:**
  1. **YouTube:** Launches official YouTube web app (`chromium --app=https://www.youtube.com`) signed into the user's **YouTube Premium** account (ad-free playback, synced history, background audio).
  2. **Netflix:** Launches official Netflix web app via Widevine-enabled Chromium (`--app=https://www.netflix.com`).
  3. **Prime Video:** Launches official Prime Video web app via Widevine-enabled Chromium (`--app=https://www.primevideo.com`).
  4. **Anime (Ad-Free HD):** Launches user's preferred anime streaming portal inside a hardened, ad-blocked (uBlock Origin) Chromium `--app` window (exact portal URL/config TBD).
  5. **Stremio:** Launches the native Linux desktop Stremio client (hardware-accelerated via Intel HD 620 QuickSync/VA-API) as the all-rounder fallback.
* **Return Gesture:** A compositor-level touch edge-swipe or floating translucent "Home" overlay returns focus immediately to the Center Ambient Hub from any fullscreen video app (and optionally pauses background media if configured).

---

### 3.2 Automatic Smart Night Mode (Dark-Room Protection)

* **Trigger:** Continuous polling of the Surface Pro 5's built-in Ambient Light Sensor via Linux IIO subsystem (`/sys/bus/iio/devices/iio:device*/in_illuminance_raw`), with a configurable lux threshold and manual voice/touch override.
* **Behavior:**
  * When room lights turn off (lux drops below threshold), the background wallpaper/MP4 fades to pure `#000000` black, all glassmorphism pills/weather overlays hide, and the hardware IPS LCD backlight (`/sys/class/backlight/intel_backlight/brightness`) lowers to a minimum level (~1–5%) so the panel emits near-zero glow.
  * Only a **super-dim, low-glare night clock** (dim warm amber typography) remains visible in a dark bedroom.
  * Tapping the screen or triggering the wake word temporarily restores dim UI controls; turning room lights back on smoothly restores the full Ambient Hub.

---

### 3.3 Always-On Local Voice Assistant & Integrations

* **Activation:** Hands-free, always-listening `openWakeWord` engine using the Surface's built-in dual-array microphones (with a subtle visual listening indicator dot on the UI when triggered).
* **Core Local Capabilities (Offline):**
  * **Alarms & Timers:** Set, query, snooze, and dismiss morning alarms and countdown timers by voice (*"Hey [WakeWord], set an alarm for 7:30 AM"*, *"I woke up, stop alarms"*, *"Snooze"*).
  * **UI & Media Control:** Switch panes, skip wallpapers, toggle night mode, start sleep timers, pause/resume playback.
* **Free Web-Grounded General Knowledge ($0):**
  * Custom Home Assistant intent fallback querying free, no-key endpoints (**Wikipedia REST API**, **DuckDuckGo Instant Answer API**, **Open-Meteo**) so general trivia, definitions, time-zone checks, and weather questions are answered cleanly via Piper TTS.
* **Android Messaging & Phone Bridge (via KDE Connect — Exact Scope Pending Research):**
  * **SMS & WhatsApp Replies:** Voice-triggered outbound SMS (`kdeconnect-cli --send-sms`) and quick replies to incoming WhatsApp notifications bridged from the primary Android phone. Initiating new outbound WhatsApp messages is treated as an ideal goal to investigate during Phase 2.
  * **Voice Calls (Phase 2 / Stretch Goal):** Experimental Bluetooth HFP audio routing / `tel:` intent dialing via KDE Connect (explicitly scoped as a non-blocking bonus feature).

---

### 3.4 Modular Volume Control & Sleep Timer Automation

* **PipeWire Stream Separation (Mandatory Virtual Sink Routing):** PipeWire virtual sinks (`media-sink`, `tts-sink`, `alarm-sink`) and WirePlumber routing rules separate audio streams into independent, **fully user-controllable** channels (no hard locks or volume caps):
  * **Alarms (`alarm-sink`):** Defaults to **100%**, independently adjustable by the user regardless of media level.
  * **Voice Assistant (`tts-sink` / Piper TTS):** Defaults to **50%** for conversational night responses, independently adjustable by the user.
  * **Media Playback (`media-sink` — YouTube/Netflix/Prime/Stremio):** Controlled directly by the Surface Pro's physical top-edge volume rocker buttons (`XF86AudioRaiseVolume` / `XF86AudioLowerVolume`), triggering the custom on-screen modular `VolumeOSD` where the user can independently adjust all three streams.
* **Sleep Timer Execution:** When the Sleep Timer expires, the system daemon pauses active media players (via `playerctl` / MPRIS D-Bus), closes or minimizes active video windows, returns to Pane 1 (Center), and forces Smart Night Mode.

---

## 4. Non-Functional & Hardware Requirements

1. **Thermal & Battery Safety:** UEFI **Battery Limit Mode** must be enabled (`Volume Up + Power` at boot) to cap battery charge at **50%**, preventing lithium-ion swelling during 24/7 plugged-in bedside operation.
2. **Resource Budget:** Total idle RAM footprint (OS + Docker Home Assistant + Voice Pipeline + Kiosk UI) must remain under **3.5 GB of the 8 GB available**, leaving ≥4.5 GB headroom for 1080p/4K video decoding in Chromium/Stremio.
3. **Hardware Video Acceleration:** Configure Intel VA-API (`intel-media-va-driver`) for Intel HD Graphics 620 so looping `.mp4` wallpapers and streaming video decode on GPU with minimal CPU heat.
4. **Media Ingestion:** Standard local directory structure (`~/wallpapers/static`, `~/wallpapers/loops`) ready for future network sync (SMB/Syncthing) without code changes.

---

## 5. Proposed Repository Structure (For Antigravity Workspace)

```text
bedside-nest-hub/
├── README.md
├── docker-compose.yml              # Home Assistant, Whisper, Piper, openWakeWord
├── system/
│   ├── setup-surface.sh            # linux-surface kernel, VA-API, KDE Connect setup
│   ├── pipewire-rules/             # Modular virtual sink routing (independent Alarm, TTS, Media)
│   └── systemd/                    # Autostart services for daemon & kiosk browser
├── daemon/                         # Python FastAPI / WebSocket hardware bridge
│   ├── main.py
│   ├── ambient_light.py            # IIO lux sensor reader -> Night Mode trigger
│   ├── media_launcher.py           # Chromium --app / Stremio window & MPRIS control
│   └── kde_bridge.py               # Battery sync & SMS/notification helpers
├── homeassistant/
│   ├── configuration.yaml          # REST sensors (Wiki/DDG/Meteo), template entities
│   └── intents/                    # Custom voice intent definitions
└── frontend/                       # Custom 3-Pane Glassmorphism Kiosk UI
    ├── package.json
    └── src/
        ├── components/
        │   ├── SmartHomePane.tsx   # Left Pane: Centralized HA controls (placeholders)
        │   ├── AmbientHubPane.tsx  # Center Pane: MP4/Art loop, Clock, Night Mode
        │   ├── DevicePill.tsx      # Tap-to-expand battery pill
        │   ├── MediaLauncher.tsx   # Right Pane: YT Premium, Netflix, Prime, Anime, Stremio
        │   └── VolumeOSD.tsx       # Modular volume overlay
        └── services/
            ├── haSocket.ts         # Home Assistant WebSocket client
            └── daemonSocket.ts     # Hardware daemon WebSocket client
```

---

## 6. Phased Implementation Roadmap

* **Phase 1 — OS & Hardware Foundation:** Enable UEFI 50% Battery Limit Mode, install Ubuntu 24.04 LTS + `linux-surface` kernel, configure the dedicated Wayland kiosk compositor + Intel VA-API hardware decoding + SSH access for Mac-to-Surface file sync, and verify touchscreen, ambient light sensor, and dual mics.
* **Phase 2 — Backend Brain & Voice:** Spin up Home Assistant + local Assist (`openWakeWord` + `Faster-Whisper` + `Piper`) via `docker-compose`, configure free Wiki/DDG/Open-Meteo intents, and pair Android devices via `KDE Connect`.
* **Phase 3 — System Daemon & Audio:** Build the Python hardware daemon (lux polling, Wayland compositor window control, app launching, MPRIS sleep timer) and configure PipeWire modular volume rules.
* **Phase 4 — Custom 3-Pane Frontend:** Build and polish the React + TypeScript + Vite + Tailwind CSS glassmorphism kiosk UI (3-pane touch swipe, looping MP4 wallpaper engine, expandable device battery pill, ultra-dim night clock, and media launcher tiles).
