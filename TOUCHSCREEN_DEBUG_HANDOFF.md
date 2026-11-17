# Touchscreen Root-Cause Analysis & Resolution (`fix/touchscreen`)

**Date:** 2026-11-17  
**Branch:** `fix/touchscreen`  
**SSH Target:** `time-master@192.168.0.100`  
**Hardware / OS:** Microsoft Surface Pro 5 (`Surface_Pro_1796`), Ubuntu 26.04.1 LTS, kernel `7.3.4-1-surface`, Sway `1.11-3` (`1563×1042` logical @ `1.75` scale), Brave `157.1.99.57`, `iptsd 3.1.1-1` (`045E:001F`)

---

## 1. Verified Root Causes

### A. Why Lower-Half Swipes Were Failing (Two 100%-Reproducible Frontend Bugs)

Analysis of 709 raw touch/pointer events in `window.__touchLog` proved that lower-half touch events were delivered cleanly by `iptsd` → `libinput` → Sway → Brave at 60Hz, but were aborted by two frontend bugs:

1. **Child implicit touch pointer capture bubbling (`App.tsx`):**
   - On `pointerdown`, Chromium grants **implicit touch pointer capture** to the touched child element (`<section>`, `<time>`, `<div>`, `<button>`).
   - In `handlePointerMove` ([frontend/src/App.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/App.tsx)), as soon as horizontal movement reached `28px`, `<main class="pane-track">` called `event.currentTarget.setPointerCapture(event.pointerId)`, stealing pointer capture from the child element.
   - On the very next frame (`16ms` later), Chromium dispatched `lostpointercapture` to the child element, which **bubbled up** to `<main>`'s `onLostPointerCapture={handleLostPointerCapture}`.
   - Because `handleLostPointerCapture` did not check `if (event.target !== event.currentTarget) return;`, `<main>` treated the child's `lostpointercapture` as `<main>` losing capture and immediately called `finalizeDrag()` `16ms` into the swipe (while `|dx|` was `31–49px < 60px`), releasing capture and aborting 10 out of 13 swipes on `AmbientHubPane`.

2. **Missing `touch-action: none` on `SmartHomePane` and `MediaLauncher` (`index.css`):**
   - `AmbientHubPane` used `.pane-no-scroll` (`touch-action: none`), which had **0 `pointercancel` events**.
   - `SmartHomePane` (`Room Controls`) and `MediaLauncher` (`Bedside Theater`) used `.pane-item` (`overflow-y: auto; touch-action: auto`) inside `.pane-track` (`touch-action: pan-y`), and `button, a` used `touch-action: manipulation`.
   - As soon as a finger moved ~25–35px horizontally across `SmartHomePane` or `MediaLauncher`, Chromium's compositor gesture detector claimed the touch stream and fired `pointercancel` (**24 out of 24 swipes cancelled**), causing `finalizeDrag(..., canceled = true)` to snap back and making it impossible to swipe back to the Hub.

---

### B. Why the Upper Half Stops at Exactly `y = 607px` (Raw `/dev/hidraw2` Heatmap Proof)

Capturing 57 raw `7488`-byte HID reports (`Report ID 0x41`, capacitance payload `Tag 0x0425`, size `0x0b00 = 2816` bytes) directly from `/dev/hidraw2` while sliding a finger from the bottom half (`y ≈ 850px`) into the top half (`y ≈ 200px`) and back down proved:

- The Surface Pro 5 IPTS sensor matrix is **44 rows × 64 columns** (`2816` bytes). With `InvertY = true` (`/usr/share/iptsd/surface-pro-6.conf`), **Row 0** is the bottom edge (`y = 1042px`) and **Row 43** is the top edge (`y = 0px`).
- **Row 18** maps to:
  $$y = 1042 \times \left(1 - \frac{18}{43}\right) = 605.8\text{ px} \approx 607\text{ px}$$
- **Rows `0..18` (`y = 607..1042px`, lower 43.2% of display):** All 19 horizontal TX drive lines and all 64 vertical RX columns produce healthy mutual-capacitance readings (untouched baseline `180` / `0xb4`, dropping to `64–95` under a finger).
- **Rows `19..43` (`y = 0..606px`, upper 56.8% of display):** All 25 upper horizontal TX drive lines on the digitizer panel are **dead at the hardware level**, outputting constant unscanned `[180, 180, 180, ...]` (`0xb4`) and open-circuit `[0, 0, 0, ...]` (`0x00`) banks directly from the touch controller even when a finger is directly on `Row 18` (`val = 86`) and crosses into `Row 19` (`val = 180`).

---

## 2. Fixes Implemented

1. **Swipe & Pointer Capture Fixes ([frontend/src/App.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/App.tsx), [frontend/src/index.css](file:///Users/kaushik/Projects/surface_pro/frontend/src/index.css)):**
   - Guarded `handleLostPointerCapture` with `if (event.target !== event.currentTarget) return;` and added a unit regression test in [frontend/src/__tests__/App.test.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/__tests__/App.test.tsx).
   - Replaced inline `inert` ref callbacks on the 3 pane wrappers with stable `useRef`s updated only when `activePane` changes.
   - Set `touch-action: none` and `overflow: hidden` across `.pane-track`, `.pane-item`, and `button, a` so Chromium never fires `pointercancel` during horizontal swipes.
2. **Lower-Half Interactive UX Layout (`y >= 620px` on `1563×1042`):**
   - **[frontend/src/components/AmbientHubPane.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/components/AmbientHubPane.tsx):** Moved `← Controls` and `Media →` navigation pills from the top edge (`y ≈ 40px`) into the lower-right control bar (`y >= 950px`).
   - **[frontend/src/components/MediaLauncher.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/components/MediaLauncher.tsx):** Converted the upper area into an ambient theater marquee (`pointer-events-none`) and anchored the `< Hub` button + all 5 media tiles (`YouTube`, `Netflix`, `Prime Video`, `Anime`, `Stremio`) into a bottom-aligned 5-column launcher deck (`y ≈ 680..990px`).
   - **[frontend/src/components/SmartHomePane.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/components/SmartHomePane.tsx):** Converted the upper area into an ambient status header and anchored the `Scenes` bar, `Hub >` button, `Bedroom Lighting`, `Climate / AC`, and `Smart Plugs` cards into a 3-column lower control deck (`y ≈ 640..990px`).
   - **[frontend/src/components/VolumeOSD.tsx](file:///Users/kaushik/Projects/surface_pro/frontend/src/components/VolumeOSD.tsx):** Bottom-aligned the audio mixer dialog (`items-end pb-12`) in a 3-column horizontal layout (`max-w-4xl`, `y ≈ 740..994px`) so all volume sliders, mute toggles, and the close button sit inside the working lower half.
3. **Bottom-Right Waybar `⌂ Home` Pill & Session Cleanup ([system/waybar/config.jsonc](file:///Users/kaushik/Projects/surface_pro/system/waybar/config.jsonc), [system/sway/config](file:///Users/kaushik/Projects/surface_pro/system/sway/config)):**
   - Moved Waybar's floating `⌂ Home` pill from `"position": "top"` to `"position": "bottom"` (`margin-bottom: 20, margin-right: 20`, `y ≈ 960..1022px`) so fullscreen video apps on `workspace 2:media` can be exited by touch.
   - Cleaned up orphaned `waybar-home-state.sh` processes on reload and cleared `kiosk-profile/Default/Sessions` before launching Brave so session restore never creates hidden duplicate background tabs.
