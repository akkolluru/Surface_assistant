import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { AmbientHubPane } from "../components/AmbientHubPane";
import { DevicePill } from "../components/DevicePill";
import { SimulatorConsole } from "../components/SimulatorConsole";
import { SmartHomePane } from "../components/SmartHomePane";
import { VolumeOSD } from "../components/VolumeOSD";
import * as daemonSocket from "../services/daemonSocket";
import { DEFAULT_DAEMON_SNAPSHOT } from "../services/daemonSocket";
import { PLACEHOLDER_HA_ENTITIES } from "../services/haSocket";
import type { DaemonEvent, DaemonStateSnapshot } from "../types/hub";

function makeSnapshot(overrides: Partial<DaemonStateSnapshot> = {}): DaemonStateSnapshot {
  return {
    ...DEFAULT_DAEMON_SNAPSHOT,
    ...overrides,
  };
}

describe("Frontend Component QA Suite", () => {
  afterEach(() => {
    if (window.location.pathname !== "/") {
      window.history.pushState({}, "", "/");
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("AmbientHubPane", () => {
    it("formats 12h vs 24h clocks, updates on 15s tick, and converts weather to °F", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 18, 14, 5, 0));

      const baseWeather = {
        temperature_c: 25,
        condition_code: 0,
        condition_label: "Clear",
        updated_at: "2026-11-18T08:35:00Z",
      };

      const { rerender } = render(
        <AmbientHubPane
          state={makeSnapshot({
            clock_format: "12h",
            temperature_unit: "F",
            weather: baseWeather,
          })}
          onNextWallpaper={vi.fn()}
          onSetSleepTimer={vi.fn()}
          onToggleNightMode={vi.fn()}
          onOpenVolume={vi.fn()}
          onNavigatePane={vi.fn()}
        />
      );

      expect(screen.getByText("2:05")).toBeInTheDocument();
      expect(screen.getByText("PM")).toBeInTheDocument();
      expect(screen.getByText(/77°F · Clear/)).toBeInTheDocument();

      // Advance 60s so the 15s clock interval refreshes displayed minute
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("2:06")).toBeInTheDocument();

      rerender(
        <AmbientHubPane
          state={makeSnapshot({
            clock_format: "24h",
            temperature_unit: "C",
            weather: baseWeather,
          })}
          onNextWallpaper={vi.fn()}
          onSetSleepTimer={vi.fn()}
          onToggleNightMode={vi.fn()}
          onOpenVolume={vi.fn()}
          onNavigatePane={vi.fn()}
        />
      );

      expect(screen.getByText("14:06")).toBeInTheDocument();
      expect(screen.queryByText("PM")).not.toBeInTheDocument();
      expect(screen.queryByText("AM")).not.toBeInTheDocument();
      expect(screen.getByText(/25°C · Clear/)).toBeInTheDocument();
    });

    it("opens sleep timer preset menu, selects presets, and dismisses via Escape or outside click", () => {
      const onSetSleepTimer = vi.fn();

      render(
        <AmbientHubPane
          state={makeSnapshot({
            media: {
              ...DEFAULT_DAEMON_SNAPSHOT.media,
              sleep_timer_remaining_seconds: 900,
            },
          })}
          onNextWallpaper={vi.fn()}
          onSetSleepTimer={onSetSleepTimer}
          onToggleNightMode={vi.fn()}
          onOpenVolume={vi.fn()}
          onNavigatePane={vi.fn()}
        />
      );

      expect(screen.getByText("Sleep in 15m")).toBeInTheDocument();
      const sleepBtn = screen.getByRole("button", { name: "Sleep timer" });
      expect(sleepBtn).toHaveTextContent("15m");
      expect(sleepBtn).toHaveAttribute("aria-expanded", "false");

      // Open and select 30m
      fireEvent.click(sleepBtn);
      expect(sleepBtn).toHaveAttribute("aria-expanded", "true");
      const menu = screen.getByRole("menu", { name: "Sleep timer presets" });
      fireEvent.click(within(menu).getByRole("menuitem", { name: "30m" }));
      expect(onSetSleepTimer).toHaveBeenCalledWith(30);
      expect(screen.queryByRole("menu", { name: "Sleep timer presets" })).not.toBeInTheDocument();

      // Reopen and select Off -> 0
      fireEvent.click(sleepBtn);
      fireEvent.click(screen.getByRole("menuitem", { name: "Off" }));
      expect(onSetSleepTimer).toHaveBeenCalledWith(0);

      // Reopen and dismiss via Escape
      fireEvent.click(sleepBtn);
      expect(screen.getByRole("menu", { name: "Sleep timer presets" })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("menu", { name: "Sleep timer presets" })).not.toBeInTheDocument();

      // Reopen and dismiss by clicking outside controls onto the Ambient Hub section
      fireEvent.click(sleepBtn);
      expect(screen.getByRole("menu", { name: "Sleep timer presets" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("region", { name: "Ambient Hub" }));
      expect(screen.queryByRole("menu", { name: "Sleep timer presets" })).not.toBeInTheDocument();
    });

    it("supports Night Mode tap-to-peek, bumps 8s timeout on interaction, and restores controls", () => {
      vi.useFakeTimers();
      const onToggleNightMode = vi.fn();

      render(
        <AmbientHubPane
          state={makeSnapshot({
            night_mode: { ...DEFAULT_DAEMON_SNAPSHOT.night_mode, enabled: true },
          })}
          onNextWallpaper={vi.fn()}
          onSetSleepTimer={vi.fn()}
          onToggleNightMode={onToggleNightMode}
          onOpenVolume={vi.fn()}
          onNavigatePane={vi.fn()}
        />
      );

      const hubSection = screen.getByRole("region", { name: "Ambient Hub" });
      const disableNightBtn = screen.getByRole("button", { name: "Disable night mode" });
      const controlsDeck = disableNightBtn.closest("div.flex-col")!;

      expect(controlsDeck).toHaveClass("pointer-events-none", "opacity-0");
      expect(screen.queryByRole("button", { name: "Next wallpaper" })).not.toBeInTheDocument();

      // Tap Ambient Hub section -> reveals dim controls
      fireEvent.click(hubSection);
      expect(controlsDeck).toHaveClass("opacity-100");
      expect(controlsDeck).not.toHaveClass("pointer-events-none");

      // Advance 6s then interact with controls -> resets 8s auto-hide timer
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(controlsDeck).toHaveClass("opacity-100");

      fireEvent.pointerDown(controlsDeck);
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      // Still visible 10s after initial tap because pointerDown bumped the 8s timer at 6s
      expect(controlsDeck).toHaveClass("opacity-100");

      // Advance remaining 4s -> auto-hides again
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(controlsDeck).toHaveClass("pointer-events-none", "opacity-0");

      // Tap again and click Disable night mode
      fireEvent.click(hubSection);
      fireEvent.click(disableNightBtn);
      expect(onToggleNightMode).toHaveBeenCalledWith(false);
    });

    it("renders video and image wallpapers and invokes onNextWallpaper", () => {
      const onNextWallpaper = vi.fn();
      const items = [
        {
          id: "wp-vid",
          filename: "rain.mp4",
          kind: "video" as const,
          url: "/api/wallpapers/file/wp-vid",
        },
        {
          id: "wp-img",
          filename: "forest.jpg",
          kind: "image" as const,
          url: "/api/wallpapers/file/wp-img",
        },
      ];

      const { container, rerender } = render(
        <AmbientHubPane
          state={makeSnapshot({
            wallpapers: { current_index: 0, interval_seconds: 180, items },
          })}
          onNextWallpaper={onNextWallpaper}
          onSetSleepTimer={vi.fn()}
          onToggleNightMode={vi.fn()}
          onOpenVolume={vi.fn()}
          onNavigatePane={vi.fn()}
        />
      );

      const video = container.querySelector("video");
      expect(video).not.toBeNull();
      expect(video).toHaveAttribute("src", "/api/wallpapers/file/wp-vid");
      expect(video).toHaveAttribute("autoplay");
      expect(video).toHaveAttribute("loop");
      expect(video).toHaveAttribute("playsinline");
      expect(video!.muted).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Next wallpaper" }));
      expect(onNextWallpaper).toHaveBeenCalledTimes(1);

      rerender(
        <AmbientHubPane
          state={makeSnapshot({
            wallpapers: { current_index: 1, interval_seconds: 180, items },
          })}
          onNextWallpaper={onNextWallpaper}
          onSetSleepTimer={vi.fn()}
          onToggleNightMode={vi.fn()}
          onOpenVolume={vi.fn()}
          onNavigatePane={vi.fn()}
        />
      );

      expect(container.querySelector("video")).toBeNull();
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute("src", "/api/wallpapers/file/wp-img");
    });
  });

  describe("DevicePill", () => {
    it("shows empty devices fallback and collapses on outside pointerdown or 10s timer", () => {
      vi.useFakeTimers();

      const { rerender } = render(<DevicePill devices={[]} />);
      const trigger = screen.getByRole("button", { name: "Connected devices (0 online)" });
      fireEvent.click(trigger);

      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("0/0 online")).toBeInTheDocument();
      expect(screen.getByText("No paired devices found.")).toBeInTheDocument();

      // Clicking inside panel does not collapse it
      fireEvent.pointerDown(screen.getByText("KDE Connect"));
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Outside pointerdown collapses it
      fireEvent.pointerDown(document.body);
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      // Re-render with mixed devices (charging, null battery, offline) and test 10s auto-collapse
      rerender(
        <DevicePill
          devices={[
            {
              id: "p1",
              name: "Pixel 10 Pro",
              device_type: "phone",
              reachable: true,
              battery_percent: 78,
              charging: true,
            },
            {
              id: "l1",
              name: "Main Laptop",
              device_type: "laptop",
              reachable: false,
              battery_percent: null,
              charging: false,
            },
          ]}
        />
      );

      const populatedTrigger = screen.getByRole("button", { name: "Connected devices (1 online)" });
      fireEvent.click(populatedTrigger);
      expect(screen.getByText("1/2 online")).toBeInTheDocument();
      expect(screen.getByLabelText("Charging")).toBeInTheDocument();
      expect(screen.getByText("78%")).toBeInTheDocument();
      expect(screen.getByText("Offline")).toBeInTheDocument();
      expect(screen.getByText("--")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(populatedTrigger).toHaveAttribute("aria-expanded", "true");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(populatedTrigger).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("SmartHomePane", () => {
    const withHaStates = (overrides: Record<string, string>) => {
      const next = { ...PLACEHOLDER_HA_ENTITIES };
      for (const [entityId, state] of Object.entries(overrides)) {
        const base = next[entityId];
        if (base) {
          next[entityId] = { ...base, state };
        }
      }
      return next;
    };

    it("renders HA Live vs HA Preview status and all four upper ambient stage states", () => {
      const { rerender } = render(
        <SmartHomePane
          entities={PLACEHOLDER_HA_ENTITIES}
          haConnected={true}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );

      // 1. All Off + HA Live -> pure black stage, All Quiet, mounted halos at opacity-0
      expect(screen.getByText("HA Live")).toBeInTheDocument();
      expect(screen.getByText("All Quiet")).toBeInTheDocument();
      expect(screen.getByText("Bedroom resting")).toBeInTheDocument();
      expect(screen.getByTestId("ambient-horizon-glow")).toBeInTheDocument();
      expect(screen.getByTestId("ambient-horizon-amber")).toHaveClass("opacity-0");
      expect(screen.getByTestId("ambient-horizon-sky")).toHaveClass("opacity-0");

      // 1b. Outlets Active (while Lights & AC remain off) -> HA Preview + active plug names
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.desk_plug": "on",
          })}
          haConnected={false}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("HA Preview")).toBeInTheDocument();
      expect(screen.getByText("Outlets Active")).toBeInTheDocument();
      expect(screen.getByText("Desk Plug", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByTestId("ambient-horizon-amber")).toHaveClass("opacity-0");
      expect(screen.getByTestId("ambient-horizon-sky")).toHaveClass("opacity-0");

      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.desk_plug": "on",
            "input_boolean.fan_plug": "on",
          })}
          haConnected={false}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("Desk Plug · Standing Fan")).toBeInTheDocument();

      // 2. Lights Only (Lamp only -> Warm; Ceiling only -> %; Ceiling + Lamp -> Ceiling · Lamp)
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedside_lamp": "on",
          })}
          haConnected={true}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("Warm")).toBeInTheDocument();
      expect(screen.getByText("Bedside Lamp", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByTestId("ambient-horizon-amber")).toHaveClass("opacity-100");
      expect(screen.getByTestId("ambient-horizon-amber").style.background).toContain(
        "251, 191, 36"
      );
      expect(screen.getByTestId("ambient-horizon-sky")).toHaveClass("opacity-0");

      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_number.bedroom_light_brightness": "75",
          })}
          haConnected={true}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("75%", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByText("Ceiling", { selector: "p" })).toBeInTheDocument();

      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_boolean.bedside_lamp": "on",
            "input_number.bedroom_light_brightness": "80",
          })}
          haConnected={true}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("80%", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByText("Ceiling · Lamp")).toBeInTheDocument();

      // 3. AC Only -> Cool sky ring & horizon glow, amber smoothly fades to opacity-0
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_ac_power": "on",
            "input_number.bedroom_ac_temp": "22",
            "input_select.bedroom_ac_mode": "Dry",
          })}
          haConnected={true}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("22°C", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByText("AC · Dry")).toBeInTheDocument();
      expect(screen.getByTestId("ambient-horizon-amber")).toHaveClass("opacity-0");
      expect(screen.getByTestId("ambient-horizon-sky")).toHaveClass("opacity-100");
      expect(screen.getByTestId("ambient-horizon-sky").style.background).toContain("56, 189, 248");

      // 4. Lights + AC coexistence -> open typographic pair, blended horizon wash, no outlet sub-pill
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_boolean.bedside_lamp": "on",
            "input_number.bedroom_light_brightness": "70",
            "input_boolean.bedroom_ac_power": "on",
            "input_number.bedroom_ac_temp": "21",
            "input_select.bedroom_ac_mode": "Eco",
            "input_boolean.desk_plug": "on",
          })}
          haConnected={true}
          onCallService={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByText("70%", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByText("Ceiling · Lamp")).toBeInTheDocument();
      expect(screen.getByText("21°C", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByText("AC · Eco")).toBeInTheDocument();
      expect(screen.queryByText("Outlets Active")).not.toBeInTheDocument();
      expect(screen.queryByText("All Quiet")).not.toBeInTheDocument();
      expect(screen.getByTestId("ambient-horizon-amber")).toHaveClass("opacity-100");
      expect(screen.getByTestId("ambient-horizon-amber").style.background).toContain(
        "251, 191, 36"
      );
      expect(screen.getByTestId("ambient-horizon-sky")).toHaveClass("opacity-100");
      expect(screen.getByTestId("ambient-horizon-sky").style.background).toContain("56, 189, 248");
    });

    it("triggers scenes with 1500ms pulse, resets timer on re-tap, cleans up on unmount, and navigates to Hub", () => {
      vi.useFakeTimers();
      const onCallService = vi.fn();
      const onNavigateHub = vi.fn();

      const { unmount } = render(
        <SmartHomePane
          entities={PLACEHOLDER_HA_ENTITIES}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={onNavigateHub}
        />
      );

      expect(screen.queryByText("Scenes")).not.toBeInTheDocument();

      const relaxBtn = screen.getByRole("button", { name: "Relax" });
      const movieBtn = screen.getByRole("button", { name: "Movie" });
      const goodnightBtn = screen.getByRole("button", { name: "Goodnight" });

      fireEvent.click(relaxBtn);
      expect(onCallService).toHaveBeenCalledWith("scene", "turn_on", {
        entity_id: "scene.evening_relax",
      });
      expect(relaxBtn).toHaveClass("scene-pulse");

      // Re-tapping another scene after 1000ms cancels the previous timer and starts a fresh 1500ms pulse
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      fireEvent.click(movieBtn);
      expect(onCallService).toHaveBeenCalledWith("scene", "turn_on", {
        entity_id: "scene.movie_night",
      });
      expect(relaxBtn).not.toHaveClass("scene-pulse");
      expect(movieBtn).toHaveClass("scene-pulse");

      act(() => {
        vi.advanceTimersByTime(1_499);
      });
      expect(movieBtn).toHaveClass("scene-pulse");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(movieBtn).not.toHaveClass("scene-pulse");

      // Trigger Goodnight and verify Hub navigation
      fireEvent.click(goodnightBtn);
      expect(onCallService).toHaveBeenCalledWith("scene", "turn_on", {
        entity_id: "scene.goodnight",
      });
      expect(goodnightBtn).toHaveClass("scene-pulse");

      fireEvent.click(screen.getByRole("button", { name: "Hub" }));
      expect(onNavigateHub).toHaveBeenCalledTimes(1);

      // Unmount clears pending 1500ms scene pulse timeout
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it("controls lighting toggles, muted/warm brightness slider vars, AC mode cycling, clamped temp bounds, and smart plugs", () => {
      const onCallService = vi.fn();

      const { rerender } = render(
        <SmartHomePane
          entities={PLACEHOLDER_HA_ENTITIES}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );

      // Lighting toggles & Brightness slider (muted slate CSS vars when Ceiling is off)
      const ceilingBtn = screen.getByRole("button", { name: "Ceiling" });
      const lampBtn = screen.getByRole("button", { name: "Bedside Lamp" });
      expect(ceilingBtn).toHaveAttribute("aria-pressed", "false");
      expect(lampBtn).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(ceilingBtn);
      expect(onCallService).toHaveBeenCalledWith("input_boolean", "toggle", {
        entity_id: "input_boolean.bedroom_main_light",
      });
      fireEvent.click(lampBtn);
      expect(onCallService).toHaveBeenCalledWith("input_boolean", "toggle", {
        entity_id: "input_boolean.bedside_lamp",
      });

      const brightnessSlider = screen.getByRole("slider", { name: "Brightness" });
      expect(brightnessSlider).toHaveClass("hub-range");
      expect(brightnessSlider).toHaveAttribute("aria-valuetext", "60%");
      expect(brightnessSlider.style.getPropertyValue("--slider-fill-color")).toBe("#94a3b8");

      fireEvent.change(brightnessSlider, { target: { value: "85" } });
      expect(onCallService).toHaveBeenCalledWith("input_number", "set_value", {
        entity_id: "input_number.bedroom_light_brightness",
        value: 85,
      });

      // Warm amber CSS vars when Ceiling is on
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_number.bedroom_light_brightness": "85",
          })}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "Ceiling" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      expect(brightnessSlider).toHaveAttribute("aria-valuetext", "85%");
      expect(brightnessSlider.style.getPropertyValue("--slider-fill-color")).toBe("#fbbf24");

      // AC toggle & +/- stepping from 24
      const acBtn = screen.getByRole("button", { name: "AC" });
      expect(acBtn).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(acBtn);
      expect(onCallService).toHaveBeenCalledWith("input_boolean", "toggle", {
        entity_id: "input_boolean.bedroom_ac_power",
      });

      const decBtn = screen.getByRole("button", { name: "Decrease AC target temperature" });
      const incBtn = screen.getByRole("button", { name: "Increase AC target temperature" });
      expect(decBtn).toBeEnabled();
      expect(incBtn).toBeEnabled();

      onCallService.mockClear();
      fireEvent.click(incBtn);
      fireEvent.click(incBtn);
      expect(onCallService).toHaveBeenNthCalledWith(1, "input_number", "set_value", {
        entity_id: "input_number.bedroom_ac_temp",
        value: 25,
      });
      expect(onCallService).toHaveBeenNthCalledWith(2, "input_number", "set_value", {
        entity_id: "input_number.bedroom_ac_temp",
        value: 26,
      });
      expect(screen.getByText("26°C")).toBeInTheDocument();

      fireEvent.click(decBtn);
      fireEvent.click(decBtn);
      expect(onCallService).toHaveBeenNthCalledWith(3, "input_number", "set_value", {
        entity_id: "input_number.bedroom_ac_temp",
        value: 25,
      });
      expect(onCallService).toHaveBeenNthCalledWith(4, "input_number", "set_value", {
        entity_id: "input_number.bedroom_ac_temp",
        value: 24,
      });
      expect(screen.getByText("24°C")).toBeInTheDocument();

      // 1-tap AC mode cycle: Cool -> Dry -> Fan -> Eco -> Cool + fallback normalization
      const expectedCycle = [
        { current: "Cool", next: "Dry" },
        { current: "Dry", next: "Fan" },
        { current: "Fan", next: "Eco" },
        { current: "Eco", next: "Cool" },
      ] as const;

      for (const { current, next } of expectedCycle) {
        rerender(
          <SmartHomePane
            entities={withHaStates({
              "input_boolean.bedroom_ac_power": "on",
              "input_select.bedroom_ac_mode": current,
            })}
            haConnected={true}
            onCallService={onCallService}
            onNavigateHub={vi.fn()}
          />
        );
        const modeBtn = screen.getByRole("button", {
          name: `${current}, switch AC mode to ${next}`,
        });
        fireEvent.click(modeBtn);
        expect(onCallService).toHaveBeenLastCalledWith("input_select", "select_option", {
          entity_id: "input_select.bedroom_ac_mode",
          option: next,
        });
      }

      // Unrecognized mode normalizes to Cool -> cycles to Dry
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_select.bedroom_ac_mode": "Turbo",
          })}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Cool, switch AC mode to Dry" })
      );
      expect(onCallService).toHaveBeenLastCalledWith("input_select", "select_option", {
        entity_id: "input_select.bedroom_ac_mode",
        option: "Dry",
      });

      // Smart plugs
      const deskPlugBtn = screen.getByRole("button", { name: "Desk Plug" });
      const fanPlugBtn = screen.getByRole("button", { name: "Standing Fan" });
      expect(deskPlugBtn).toHaveAttribute("aria-pressed", "false");
      expect(fanPlugBtn).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(deskPlugBtn);
      expect(onCallService).toHaveBeenCalledWith("input_boolean", "toggle", {
        entity_id: "input_boolean.desk_plug",
      });
      fireEvent.click(fanPlugBtn);
      expect(onCallService).toHaveBeenCalledWith("input_boolean", "toggle", {
        entity_id: "input_boolean.fan_plug",
      });

      // Lower bound disabled clamp (18)
      onCallService.mockClear();
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_number.bedroom_ac_temp": "18",
          })}
          haConnected={false}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "Decrease AC target temperature" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Increase AC target temperature" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Decrease AC target temperature" }));
      expect(onCallService).not.toHaveBeenCalled();

      // Upper bound disabled clamp (30)
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_number.bedroom_ac_temp": "30",
          })}
          haConnected={false}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "Increase AC target temperature" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Decrease AC target temperature" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Increase AC target temperature" }));
      expect(onCallService).not.toHaveBeenCalled();
    });

    it("prevents slider rubber-banding on stale mid-drag echoes and reconciles brightness & AC timers cleanly", () => {
      vi.useFakeTimers();
      const onCallService = vi.fn();

      const { rerender, unmount } = render(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_number.bedroom_light_brightness": "60",
            "input_boolean.bedroom_ac_power": "on",
            "input_number.bedroom_ac_temp": "24",
          })}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );

      const brightnessSlider = screen.getByRole("slider", { name: "Brightness" });

      // 1. Mid-drag stale HA echoes do not rubber-band thumb or --slider-progress
      fireEvent.pointerDown(brightnessSlider);
      fireEvent.change(brightnessSlider, { target: { value: "80" } });
      expect(onCallService).toHaveBeenCalledWith("input_number", "set_value", {
        entity_id: "input_number.bedroom_light_brightness",
        value: 80,
      });
      expect(brightnessSlider).toHaveValue("80");
      expect(brightnessSlider).toHaveAttribute("aria-valuetext", "80%");
      expect(brightnessSlider.style.getPropertyValue("--slider-progress")).toBe("78.95%");
      expect(screen.getByText("80%", { selector: "p" })).toBeInTheDocument();

      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_number.bedroom_light_brightness": "65",
            "input_boolean.bedroom_ac_power": "on",
            "input_number.bedroom_ac_temp": "24",
          })}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      expect(brightnessSlider).toHaveValue("80");
      expect(brightnessSlider).toHaveAttribute("aria-valuetext", "80%");
      expect(brightnessSlider.style.getPropertyValue("--slider-progress")).toBe("78.95%");
      expect(screen.getByText("80%", { selector: "p" })).toBeInTheDocument();

      // Release starts 900ms fallback reconciliation if HA ignores update
      fireEvent.pointerUp(brightnessSlider);
      act(() => {
        vi.advanceTimersByTime(899);
      });
      expect(brightnessSlider).toHaveValue("80");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(brightnessSlider).toHaveValue("65");
      expect(brightnessSlider).toHaveAttribute("aria-valuetext", "65%");

      // 2. Rapid throttled drag flushes final value on release and reconciles on HA echo
      onCallService.mockClear();
      fireEvent.pointerDown(brightnessSlider);
      fireEvent.change(brightnessSlider, { target: { value: "70" } });
      fireEvent.change(brightnessSlider, { target: { value: "90" } });
      fireEvent.pointerUp(brightnessSlider);
      expect(onCallService).toHaveBeenLastCalledWith("input_number", "set_value", {
        entity_id: "input_number.bedroom_light_brightness",
        value: 90,
      });

      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_number.bedroom_light_brightness": "90",
            "input_boolean.bedroom_ac_power": "on",
            "input_number.bedroom_ac_temp": "24",
          })}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      expect(brightnessSlider).toHaveValue("90");

      // External update after reconciliation applies immediately
      rerender(
        <SmartHomePane
          entities={withHaStates({
            "input_boolean.bedroom_main_light": "on",
            "input_number.bedroom_light_brightness": "50",
            "input_boolean.bedroom_ac_power": "on",
            "input_number.bedroom_ac_temp": "24",
          })}
          haConnected={true}
          onCallService={onCallService}
          onNavigateHub={vi.fn()}
        />
      );
      expect(brightnessSlider).toHaveValue("50");

      // 3. Direct fireEvent.change without pointerDown still dispatches and reconciles after 900ms
      onCallService.mockClear();
      fireEvent.change(brightnessSlider, { target: { value: "75" } });
      expect(onCallService).toHaveBeenCalledWith("input_number", "set_value", {
        entity_id: "input_number.bedroom_light_brightness",
        value: 75,
      });
      expect(brightnessSlider).toHaveValue("75");
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(brightnessSlider).toHaveValue("50");

      // 4. AC stepper resets 900ms timer across consecutive clicks, updates stage, and clears on unmount
      const incBtn = screen.getByRole("button", { name: "Increase AC target temperature" });
      const decBtn = screen.getByRole("button", { name: "Decrease AC target temperature" });
      fireEvent.click(incBtn);
      fireEvent.click(incBtn);
      expect(screen.getByText("26°C", { selector: "p" })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(899);
      });
      expect(screen.getByText("26°C", { selector: "p" })).toBeInTheDocument();

      fireEvent.click(decBtn);
      expect(screen.getByText("25°C", { selector: "p" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(899);
      });
      expect(screen.getByText("25°C", { selector: "p" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText("24°C", { selector: "p" })).toBeInTheDocument();

      // Unmount clears pending reconciliation timeouts cleanly
      fireEvent.change(brightnessSlider, { target: { value: "85" } });
      fireEvent.click(incBtn);
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe("VolumeOSD", () => {
    it("handles sliders for all channels and closes via Escape, backdrop click, and X button", () => {
      const onClose = vi.fn();
      const onChangeLevel = vi.fn();

      const { rerender } = render(
        <VolumeOSD
          open={false}
          audio={DEFAULT_DAEMON_SNAPSHOT.audio}
          onClose={onClose}
          onChangeLevel={onChangeLevel}
        />
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      rerender(
        <VolumeOSD
          open={true}
          audio={DEFAULT_DAEMON_SNAPSHOT.audio}
          onClose={onClose}
          onChangeLevel={onChangeLevel}
        />
      );

      fireEvent.change(screen.getByRole("slider", { name: "Media Playback volume" }), {
        target: { value: "42" },
      });
      expect(onChangeLevel).toHaveBeenCalledWith("media", { percent: 42, muted: false });

      fireEvent.change(screen.getByRole("slider", { name: "Voice Assistant volume" }), {
        target: { value: "75" },
      });
      expect(onChangeLevel).toHaveBeenCalledWith("tts", { percent: 75, muted: false });

      fireEvent.change(screen.getByRole("slider", { name: "Alarms & Timers volume" }), {
        target: { value: "90" },
      });
      expect(onChangeLevel).toHaveBeenCalledWith("alarm", { percent: 90, muted: false });

      // Clicking inside the dialog does not close
      const dialog = screen.getByRole("dialog", { name: "Modular Audio Mixer" });
      fireEvent.click(dialog);
      expect(onClose).not.toHaveBeenCalled();

      // Backdrop click closes
      fireEvent.click(dialog.parentElement!);
      expect(onClose).toHaveBeenCalledTimes(1);

      // Escape key closes
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(2);

      // X button closes
      fireEvent.click(screen.getByRole("button", { name: "Close audio mixer" }));
      expect(onClose).toHaveBeenCalledTimes(3);
    });
  });

  describe("App integration", () => {
    it("opens VolumeOSD on WS osd event, resets 5s auto-close on slider change, and renders polite toast", async () => {
      vi.useFakeTimers();
      let emitDaemonEvent!: (event: DaemonEvent) => void;

      vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(({ onEvent }) => {
        emitDaemonEvent = onEvent;
        return () => {};
      });
      vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
      const setAudioSpy = vi
        .spyOn(daemonSocket.daemonApi, "setAudioLevel")
        .mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT.audio);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ url: "", token: "" }), { status: 200 })
        )
      );

      render(<App />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // WS osd event opens VolumeOSD and updates slider value
      act(() => {
        emitDaemonEvent({
          type: "osd",
          payload: {
            channel: "media",
            audio: { ...DEFAULT_DAEMON_SNAPSHOT.audio, media_percent: 72 },
          },
        });
      });

      const mediaSlider = screen.getByRole("slider", { name: "Media Playback volume" });
      expect(mediaSlider).toHaveValue("72");

      // Interacting at 4s resets the 5s auto-close timer
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.change(mediaSlider, { target: { value: "55" } });
      expect(setAudioSpy).toHaveBeenCalledWith("media", { percent: 55, muted: false });

      act(() => {
        vi.advanceTimersByTime(4_999);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // WS toast renders inside aria-live="polite" and clears after 4s
      act(() => {
        emitDaemonEvent({
          type: "toast",
          payload: { message: "Mock SMS sent to Mom" },
        });
      });

      const notifications = screen.getByRole("region", { name: "Notifications" });
      const politeRegion = notifications.querySelector('[aria-live="polite"]');
      expect(politeRegion).toHaveTextContent("Mock SMS sent to Mom");

      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(politeRegion).toHaveTextContent("");
    });

    it("renders SimulatorConsole on /sim and marks off-screen panes inert on the hub", async () => {
      vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
      vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ url: "", token: "" }), { status: 200 })
        )
      );

      // /sim route
      window.history.pushState({}, "", "/sim");
      const simView = render(<App />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByRole("heading", { level: 1, name: "Surface Pro 5 Mac Simulator" })
      ).toBeInTheDocument();
      simView.unmount();

      // Hub route inertness on off-screen panes
      window.history.pushState({}, "", "/");
      render(<App />);
      await act(async () => {
        await Promise.resolve();
      });

      const pane0Wrapper = screen
        .getByRole("region", { name: "Smart Home Controls", hidden: true })
        .closest("div.h-screen") as HTMLElement;
      const pane1Wrapper = screen
        .getByRole("region", { name: "Ambient Hub" })
        .closest("div.h-screen") as HTMLElement;
      const pane2Wrapper = screen
        .getByRole("region", { name: "Bedside Video Launcher", hidden: true })
        .closest("div.h-screen") as HTMLElement;

      expect(pane0Wrapper.inert).toBe(true);
      expect(pane0Wrapper).toHaveAttribute("aria-hidden", "true");
      expect(pane1Wrapper.inert).toBe(false);
      expect(pane1Wrapper).toHaveAttribute("aria-hidden", "false");
      expect(pane2Wrapper.inert).toBe(true);
      expect(pane2Wrapper).toHaveAttribute("aria-hidden", "true");

      // Navigate to pane 0 -> pane 0 becomes active/non-inert while pane 1 becomes inert
      fireEvent.click(screen.getByRole("button", { name: /Go to Room Controls/i }));
      expect(pane0Wrapper.inert).toBe(false);
      expect(pane0Wrapper).toHaveAttribute("aria-hidden", "false");
      expect(pane1Wrapper.inert).toBe(true);
      expect(pane1Wrapper).toHaveAttribute("aria-hidden", "true");
      expect(pane2Wrapper.inert).toBe(true);
    });
  });

  describe("SimulatorConsole remaining controls", () => {
    it("drives rocker, lux slider, return home, media launch/close, device charge, knowledge, and messaging controls", async () => {
      let emitWsEvent!: (event: DaemonEvent) => void;
      let emitWsStatus!: (connected: boolean) => void;

      vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(
        ({ onEvent, onStatusChange }) => {
          emitWsEvent = onEvent;
          emitWsStatus = onStatusChange ?? (() => {});
          return () => {};
        }
      );

      const simSnapshot = makeSnapshot({
        devices: [
          {
            id: "pixel-10",
            name: "Google Pixel 10 Pro",
            device_type: "phone",
            reachable: true,
            battery_percent: 60,
            charging: false,
          },
        ],
      });

      vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(simSnapshot);
      const luxSpy = vi.spyOn(daemonSocket.daemonApi, "setSimLux").mockResolvedValue({
        enabled: true,
        manual_override: null,
        lux: 10,
        backlight_percent: 5,
        paused_for_video: false,
      });
      const rockerSpy = vi
        .spyOn(daemonSocket.daemonApi, "pressRocker")
        .mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT.audio);
      const launchSpy = vi
        .spyOn(daemonSocket.daemonApi, "launchMedia")
        .mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT.media);
      const homeSpy = vi
        .spyOn(daemonSocket.daemonApi, "returnHome")
        .mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT.media);
      const closeSpy = vi
        .spyOn(daemonSocket.daemonApi, "closeMedia")
        .mockRejectedValueOnce(new Error("close fail"))
        .mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT.media);
      const deviceSpy = vi
        .spyOn(daemonSocket.daemonApi, "updateSimDevice")
        .mockResolvedValue({ ok: true });
      const knowledgeSpy = vi
        .spyOn(daemonSocket.daemonApi, "queryKnowledge")
        .mockResolvedValue({ source: "wikipedia", answer: "City of Pearls" });
      const smsSpy = vi
        .spyOn(daemonSocket.daemonApi, "sendMockSms")
        .mockResolvedValue({ ok: true, detail: "SMS queued" });
      const waSpy = vi
        .spyOn(daemonSocket.daemonApi, "replyMockWhatsApp")
        .mockResolvedValue({ ok: true, detail: "WA queued" });

      render(<SimulatorConsole />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByText("WS Disconnected")).toBeInTheDocument();
      act(() => {
        emitWsStatus(true);
        emitWsEvent({ type: "state", payload: simSnapshot });
      });
      expect(screen.getByText("WS Connected")).toBeInTheDocument();

      // Lux slider
      fireEvent.change(screen.getByLabelText(/Room Illuminance/i), { target: { value: "10" } });
      await act(async () => {
        await Promise.resolve();
      });
      expect(luxSpy).toHaveBeenCalledWith(10, true);
      expect(screen.getByText(/Lux=10 -> Night Mode ON/)).toBeInTheDocument();

      // Volume rocker Up / Down / Mute
      fireEvent.click(screen.getByRole("button", { name: /Rocker -5%/i }));
      fireEvent.click(screen.getByRole("button", { name: /Rocker \+5%/i }));
      fireEvent.click(screen.getByRole("button", { name: /Toggle Mute/i }));
      expect(rockerSpy).toHaveBeenNthCalledWith(1, "down");
      expect(rockerSpy).toHaveBeenNthCalledWith(2, "up");
      expect(rockerSpy).toHaveBeenNthCalledWith(3, "mute");

      // Workspace 2 controls + Close Media error fallback
      fireEvent.click(screen.getByRole("button", { name: /Launch Netflix/i }));
      fireEvent.click(screen.getByRole("button", { name: /Waybar Home Pill/i }));
      fireEvent.click(screen.getByRole("button", { name: /Close Media/i }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(launchSpy).toHaveBeenCalledWith("netflix");
      expect(homeSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Failed to close running media.")).toBeInTheDocument();

      // Device telemetry -10% and Charging toggle
      fireEvent.click(screen.getByRole("button", { name: "-10%" }));
      fireEvent.click(screen.getByRole("button", { name: "Battery" }));
      expect(deviceSpy).toHaveBeenCalledWith({ id: "pixel-10", battery_percent: 50 });
      expect(deviceSpy).toHaveBeenCalledWith({ id: "pixel-10", charging: true });

      // Voice Knowledge query
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(knowledgeSpy).toHaveBeenCalledWith("Tell me about Hyderabad");
      expect(screen.getByText("[wikipedia] City of Pearls")).toBeInTheDocument();

      // Mock SMS & WhatsApp Reply
      fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "Alex" } });
      fireEvent.change(screen.getByLabelText("Message body"), { target: { value: "Be right there" } });
      fireEvent.click(screen.getByRole("button", { name: /Send Mock SMS/i }));
      fireEvent.click(screen.getByRole("button", { name: /Mock WhatsApp Reply/i }));
      expect(smsSpy).toHaveBeenCalledWith("Alex", "Be right there");
      expect(waSpy).toHaveBeenCalledWith("Alex", "Be right there");

      // Toast event updates status log
      act(() => {
        emitWsEvent({ type: "toast", payload: { message: "WhatsApp reply sent" } });
      });
      expect(screen.getByText("WhatsApp reply sent")).toBeInTheDocument();
    });
  });
});
