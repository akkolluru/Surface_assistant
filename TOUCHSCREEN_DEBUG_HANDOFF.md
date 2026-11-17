# Touchscreen & Phase 2 Debug Handoff (`fix/touchscreen`)

**Date:** 2026-11-17  
**Branch:** `fix/touchscreen` (pushed to `origin/fix/touchscreen` at `6afc3c1`; `main` untouched at `365b30e`)  
**SSH Target:** `time-master@192.168.0.100` (passwordless SSH; `sudo` requires interactive password)  
**Hardware / OS:** Microsoft Surface Pro 5 (`Surface_Pro_1796`), Ubuntu 26.04.1 LTS, kernel `7.3.4-1-surface`, Sway `1.11-3`, Brave `157.1.99.57`, `iptsd 3.1.1-1` (`045E:001F`)

---

## 1. Executive Summary — Where Touch Is Actually Failing

Live isolation tests on the Surface proved that **the primary failure is in the `iptsd` / IPTS kernel / digitizer layer below Sway and Brave**, with one secondary symptom on `Bedside Theater` (`MediaLauncher`):

1. **Upper & middle screen regions produce zero `libinput` / `iptsd-calibrate` events:**
   - Running `sudo libinput debug-events --device /dev/input/event29` while tapping `← Controls` (top-left), `Media →` (top-right), and swiping across the middle produced **zero output** (only `DEVICE_ADDED`).
   - Running `sudo iptsd-calibrate /dev/hidraw2` directly against the raw IPTS HID node (with `iptsd` stopped) also produced **no output** while tapping/swiping across top/middle/bottom-right.
2. **Lower screen works intermittently; touches stick down for ~66 seconds:**
   - Brave CDP `window.__touchLog` captured **12/12** clean taps on `Sleep` (`x=1301..1322, y=970..995`, `61–138ms` each) and later **18/18** taps at `x=1290..1315, y=964..990`.
   - However, a center swipe (`pointerId 15`, `x=1012 -> 695, y=608`) **froze without `pointerup`/`touchend` for 66.5 seconds** (`perf: 149935` → `216454`), finally releasing at `(695, 608)` with `touches: 0`.
   - Removing the charger (battery power) did **not** resolve the dead/intermittent upper/middle regions; the user noted *"it kind of works when i swipe on the lower part but that too like only once in a while, and it does not go back to the hub even on the lower parts."*
   - Note: The user confirmed touch **used to work across the whole screen on Windows** prior to Linux.
3. **Why each driver mode tested so far still failed:**
   - **`iptsd` with `90-touch-calibration.conf` (`18 / 14 / 0.15`):** `Sleep` (bottom-right) worked consistently; center swipe stuck down for `66.5s`; top/middle missed.
   - **Stock `iptsd` (without `/etc/iptsd.d/90-touch-calibration.conf`):** `libinput debug-events` on `event29` emitted no events on top/middle taps & swipes; lower-part swipes work only rarely and cannot swipe back from `Bedside Theater`.
   - **Raw kernel `IPTS 045E:001F Touchscreen` (`event27`) with `iptsd` stopped:** Still failed top/middle, and `Sleep` lost accuracy because `event27` reports `ID_INPUT_WIDTH_MM=292, ID_INPUT_HEIGHT_MM=165` (16:9) vs `event29`'s `259x171` (3:2) and lacks `surface-pro-6.conf` calibration.

---

## 2. Secondary Software/UI Issues to Verify Once Raw Touch Works

1. **Swiping back from `Bedside Theater` (`MediaLauncher`) / `Room Controls` (`SmartHomePane`):**
   - `AmbientHubPane` has `.pane-no-scroll` (`touch-action: none; overflow: hidden`), whereas `MediaLauncher` and `SmartHomePane` use `.pane-item` (`touch-action: pan-y; overflow-y: auto`).
   - On `MediaLauncher`, swiping across tiles starts on `<button>` (`touch-action: manipulation`) inside `.pane-track` (`touch-action: pan-y`). If a finger drifts slightly vertically before moving `28px` horizontally (`App.tsx:287-289`), Chromium's `pan-y` scroll recognizer can intercept/cancel pointer tracking (`pointercancel`).
   - Note that even on `Bedside Theater`, `1563x1042` fits without vertical scroll; consider `.pane-no-scroll` (`touch-action: none`) or lowering the horizontal swipe threshold / capturing earlier once `|dx| > 12 && |dx| > |dy| * 1.2`.
2. **Stale hidden tabs in Brave `kiosk-profile`:**
   - `http://127.0.0.1:9222/json` showed **5 page targets** for `http://127.0.0.1:8000/` (only 1 visible/focused, 4 hidden `1018x899` tabs restored from previous sessions, opening redundant WebSockets to the daemon). Clearing `kiosk-profile` session files or passing `--no-restore-last-session` / `--incognito` (or cleaning `Sessions/` on Sway startup) prevents hidden duplicate tabs.
3. **Orphaned `waybar-home-state.sh` processes on `swaymsg reload`:**
   - `exec_always` kills `waybar` (`pkill -x waybar`), which leaves the child `waybar-home-state.sh` + `swaymsg -t subscribe` (`PID 2585/2595/2596` from boot) until it next writes to the broken pipe.

---

## 3. Changes Already Implemented & Pushed on `fix/touchscreen`

All Mac tests/linters/builds passed after these commits (and were deployed to `~/Surface_assistant` + synced on Surface):

- **`b9cb8b9` — `fix(system)`:**
  - [system/sway/config](file:///Users/kaushik/Projects/surface_pro/system/sway/config): switched Brave kiosk from `--ozone-platform=x11` back to `--ozone-platform=wayland` (keeping isolated `kiosk-profile` and `--class=surface-kiosk`, verified on Surface as `shell: "xdg_shell"`, `app_id: "surface-kiosk"`), removed `GTK_TEST_TOUCHSCREEN=1` from Waybar launch, and switched Waybar to `exec_always`.
  - [system/waybar/config.jsonc](file:///Users/kaushik/Projects/surface_pro/system/waybar/config.jsonc) & [system/waybar/style.css](file:///Users/kaushik/Projects/surface_pro/system/waybar/style.css): changed `on-click-release` → `on-click` and added `min-height: 0; font-size: 0;` to `#custom-home.hidden`.
  - [system/iptsd/90-touch-calibration.conf](file:///Users/kaushik/Projects/surface_pro/system/iptsd/90-touch-calibration.conf): adjusted to `18 / 14 / 0.15` (currently **moved aside** on Surface to `/tmp/90-touch-calibration.conf.bak` for stock `iptsd` testing).
  - [system/scripts/volume-rocker.sh](file:///Users/kaushik/Projects/surface_pro/system/scripts/volume-rocker.sh): fixed double volume step (`+10%`) / double mute toggle (no-op) by using `swayosd-client --device "${SINK_TARGET}" --output-volume ... --max-volume 100` with `pactl` fallback only if `swayosd-client` fails.
  - [system/systemd/surface-wyoming-satellite.service](file:///Users/kaushik/Projects/surface_pro/system/systemd/surface-wyoming-satellite.service): fixed crash-loop (`AttributeError: __main__.run`) by using `.../wyoming-venv/bin/python -m wyoming_satellite` (unit currently stopped until Phase 3 starts `wyoming-openwakeword`).
  - [system/scripts/verify-surface.sh](file:///Users/kaushik/Projects/surface_pro/system/scripts/verify-surface.sh) & [scripts/deploy-surface.sh](file:///Users/kaushik/Projects/surface_pro/scripts/deploy-surface.sh): added `--sync-system`, safe `frontend/dist/` rsync handling, and Sway/Wayland/`iptsd` checks.
- **`59c9bce` — `fix(daemon)`:**
  - [daemon/media_launcher.py](file:///Users/kaushik/Projects/surface_pro/daemon/media_launcher.py): switched media Brave apps to `--ozone-platform=wayland` with isolated `~/.local/share/surface-assistant/media-profile`, added `env=self._build_env()` to `pause_mpris()`, validated `WAYLAND_DISPLAY`/`DISPLAY` socket existence.
  - [daemon/main.py](file:///Users/kaushik/Projects/surface_pro/daemon/main.py): offloaded `snapshot()` to `asyncio.to_thread` in `broadcast_state()` and reduced `_sleep_timer_loop()` broadcasts.
- **`6afc3c1` — `fix(frontend)`:**
  - [frontend/src/App.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/App.tsx): added `event.isPrimary === false` and active-drag guards against multi-touch lock, fast-flick handling in `finalizeDrag`, `inert` on inactive panes, `HaClient` StrictMode cleanup fix, `fetchState` vs WS race fix, and `VolumeOSD` manual vs rocker auto-close distinction.
  - [frontend/src/index.css](file:///Users/kaushik/Projects/surface_pro/frontend/src/index.css): layered `.pane-track`/`.pane-item` inside `@layer components`, added `.pane-no-scroll`, added `(any-pointer: coarse)` (`window.matchMedia('(pointer: coarse)')` is `false` on Surface while `(any-pointer: coarse)` is `true`!).
  - [frontend/src/components/AmbientHubPane.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/components/AmbientHubPane.tsx) & [frontend/src/services/haSocket.ts](file:///Users/kaushik/Projects/surface_pro/frontend/src/services/haSocket.ts): `nightPeek` interaction timer reset, `sleepMenuOpen` close guards, and HA WebSocket exponential reconnect backoff.

---

## 4. Current Live State on Surface (`time-master@192.168.0.100`)

- **Kernel:** `7.3.4-1-surface` (`Surface Pro` / `Surface_Pro_1796`)
- **`iptsd@dev-hidraw2.service`:** `active (running)`, loading `/usr/share/iptsd/surface-pro-6.conf` (`045E:001F`) + `/etc/iptsd.conf` (default thresholds `24 / 20 / 0.2`).
  - `/etc/iptsd.d/` is currently empty (`/etc/iptsd.d/90-touch-calibration.conf` was moved to `/tmp/90-touch-calibration.conf.bak`).
- **Sway inputs:** `1118:31:IPTSD_Virtual_Touchscreen_045E:001F` (`enabled`), `1118:31:IPTSD_Virtual_Stylus_045E:001F` (`enabled`), `1118:31:IPTS_045E:001F_Touchscreen` (`disabled`).
- **Brave kiosk window:** Running on workspace `1:hub` as `xdg_shell` (`app_id: "surface-kiosk"`), currently displaying `Bedside Theater | Surface Hub` (`activePane === 2`), launched temporarily with `--remote-debugging-port=9222 --remote-allow-origins=*` (restart cleanly without CDP once debugging finishes).
- **`surface-daemon.service`:** `active (running)` on `127.0.0.1:8000`.
- **`surface-wyoming-satellite.service`:** `inactive` (stopped so it doesn't loop on port `10400` before Phase 3).

---

## 5. Recommended Next Debugging Steps for Fresh Agent

1. **Inspect raw `/dev/hidraw2` IPTS frames directly (`iptsd-dump` / `iptsd-perf`):**
   - Stop `iptsd@dev-hidraw2` and run `sudo iptsd-perf /dev/hidraw2` to verify frame rate (`Hz`) and whether HID reports actually arrive when touching the upper/middle screen.
   - Capture 5–10 seconds with `sudo iptsd-dump /dev/hidraw2` (while touching upper, middle, and lower screen) and inspect raw heatmap values (`min`, `max`, `mode`, `avg`, dead rows/columns) to see why `iptsd-calibrate` failed to trigger above threshold.
2. **Test `iptsd` heatmap/neutral & sensitivity parameters on `/etc/iptsd.d/`:**
   - Test `Neutral = average` vs `Neutral = constant` (`NeutralValue = ...`), `PeakSuppressionRadius`, `SizeMax` / `AspectMax` (in case whole-hand/flat-finger contacts exceed `SizeMax = 2.0` or `AspectMax = 2.5`), and check if `ipts` kernel `debugfs` / module params or `guvcview`/Surface firmware/kernel `7.3.4-1-surface` vs Ubuntu `6.x-surface` has a known Surface Pro 5 (`045E:001F`, `IPTS EDS Version: 1`, `poll mode`) regression.
3. **Check `ipts` kernel driver / `linux-surface` issues for kernel `7.3.x` + SP5 (`045E:001F`):**
   - Kernel `7.3.4-1-surface` is very new (Nov 2026). Check `apt-cache policy linux-image-surface iptsd` and `linux-surface` GitHub issues for SP5 `045E:001F` (`poll mode` / `EDS Version: 1` partial-screen dead zones or stuck contacts) — or test an older LTS `linux-surface` kernel / Surface Pro 5 `config` (`surface-pro-5.conf` vs `surface-pro-6.conf`, `[DFT]` vs `[Contacts]` tuning).
4. **Test stylus (`IPTSD Virtual Stylus 045E:001F`) or USB mouse / Sway `libinput`:**
   - Verify whether a Surface Pen (if available) works across the whole screen (separates capacitive touch heatmap/calibration from MEI/IPTS bus issues).
5. **Frontend swipe polish (`MediaLauncher.tsx` & `SmartHomePane.tsx`):**
   - Once raw `libinput debug-events` reports reliable `TOUCH_DOWN`/`TOUCH_MOTION`/`TOUCH_UP` across the whole screen, check `touch-action` on `MediaLauncher` (`Bedside Theater` currently uses `touch-action: pan-y` via `.pane-item`, and `swipe` threshold `28px` + `1.4 * dy` can be tuned to `16px` / `1.1 * dy` or `touch-action: none` if vertical scrolling isn't needed on desktop `1563x1042`).
   - Also eliminate `dragOffsetPx` React `setState` on every `pointermove` frame in [App.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/App.tsx) (update `trackRef.current.style.transform` directly during drag and commit state only on `pointerup`) to remove React re-render jank during swipes.
