import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AmbientHubPane } from "../components/AmbientHubPane";
import { DevicePill } from "../components/DevicePill";
import { MediaLauncher } from "../components/MediaLauncher";
import { SmartHomePane } from "../components/SmartHomePane";
import { VolumeOSD } from "../components/VolumeOSD";
import { DEFAULT_DAEMON_SNAPSHOT } from "../services/daemonSocket";
import { PLACEHOLDER_HA_ENTITIES } from "../services/haSocket";

describe("Surface Assistant Kiosk UI", () => {
  it("expands and displays battery levels inside DevicePill", () => {
    render(
      <DevicePill
        devices={[
          {
            id: "1",
            name: "Primary Phone",
            device_type: "phone",
            reachable: true,
            battery_percent: 84,
            charging: false,
          },
          {
            id: "2",
            name: "Nothing Phone 1",
            device_type: "phone",
            reachable: true,
            battery_percent: 62,
            charging: true,
          },
        ]}
      />
    );

    const trigger = screen.getByRole("button", { name: /Connected devices/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Primary Phone")).toBeInTheDocument();
    expect(screen.getByText("84%")).toBeInTheDocument();
    expect(screen.getByText("Nothing Phone 1")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("renders AmbientHubPane in day mode and switches to warm amber Night Mode", () => {
    const onNight = vi.fn();
    const { rerender } = render(
      <AmbientHubPane
        state={{
          ...DEFAULT_DAEMON_SNAPSHOT,
          weather: {
            temperature_c: 27.6,
            condition_code: 1,
            condition_label: "Mainly Clear",
            updated_at: "2026-11-15T00:00:00Z",
          },
        }}
        onNextWallpaper={vi.fn()}
        onSetSleepTimer={vi.fn()}
        onToggleNightMode={onNight}
        onOpenVolume={vi.fn()}
        onNavigatePane={vi.fn()}
      />
    );

    expect(screen.getByText(/28°C/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enable night mode/i }));
    expect(onNight).toHaveBeenCalledWith(true);

    rerender(
      <AmbientHubPane
        state={{
          ...DEFAULT_DAEMON_SNAPSHOT,
          night_mode: { ...DEFAULT_DAEMON_SNAPSHOT.night_mode, enabled: true },
          weather: {
            temperature_c: 27.6,
            condition_code: 1,
            condition_label: "Mainly Clear",
            updated_at: "2026-11-15T00:00:00Z",
          },
        }}
        onNextWallpaper={vi.fn()}
        onSetSleepTimer={vi.fn()}
        onToggleNightMode={onNight}
        onOpenVolume={vi.fn()}
        onNavigatePane={vi.fn()}
      />
    );

    expect(screen.queryByText(/28°C/)).not.toBeInTheDocument();
  });

  it("triggers MediaLauncher tile callbacks and shows Resume badge", () => {
    const onLaunch = vi.fn();
    render(
      <MediaLauncher
        tiles={DEFAULT_DAEMON_SNAPSHOT.tiles}
        activeTileId="netflix"
        onLaunchTile={onLaunch}
        onNavigateHub={vi.fn()}
      />
    );

    expect(screen.getByText("Resume")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /YouTube/i }));
    expect(onLaunch).toHaveBeenCalledWith("youtube");
  });

  it("calls Home Assistant service helper from SmartHomePane", () => {
    const callService = vi.fn();
    render(
      <SmartHomePane
        entities={PLACEHOLDER_HA_ENTITIES}
        haConnected={false}
        onCallService={callService}
        onNavigateHub={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Bedside Warm Lamp/i }));
    expect(callService).toHaveBeenCalledWith("input_boolean", "toggle", {
      entity_id: "input_boolean.bedside_lamp",
    });
  });

  it("controls independent audio channels in VolumeOSD", () => {
    const onChange = vi.fn();
    render(
      <VolumeOSD
        open={true}
        audio={DEFAULT_DAEMON_SNAPSHOT.audio}
        onClose={vi.fn()}
        onChangeLevel={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Mute Alarms & Timers/i }));
    expect(onChange).toHaveBeenCalledWith("alarm", { muted: true });
  });
});
