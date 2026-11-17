import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import { AmbientHubPane } from "../components/AmbientHubPane";
import { DevicePill } from "../components/DevicePill";
import { MediaLauncher } from "../components/MediaLauncher";
import { SmartHomePane } from "../components/SmartHomePane";
import { VolumeOSD } from "../components/VolumeOSD";
import * as daemonSocket from "../services/daemonSocket";
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

  it("slides smoothly between panes via navigation dots and pointer swipe", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    vi.stubGlobal("PointerEvent", FakePointerEvent);

    render(<App />);
    await waitFor(() => expect(daemonSocket.daemonApi.fetchState).toHaveBeenCalled());
    const track = screen.getByLabelText("Bedside Hub Panes");

    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");
    expect(track.style.transition).toContain("transform 420ms");

    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    fireEvent.pointerDown(track, { clientX: 400, clientY: 200 });
    fireEvent.pointerMove(track, { clientX: 520, clientY: 205 });
    fireEvent.pointerUp(track, { clientX: 520, clientY: 205 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");

    // Ensure pointerCancel snaps back cleanly instead of sticking mid-drag
    fireEvent.pointerDown(track, { clientX: 400, clientY: 200 });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 200 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + -80px), 0, 0)");
    fireEvent.pointerCancel(track, { clientX: 320, clientY: 200 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");
    expect(track.style.transition).toContain("transform 420ms");

    // Swiping starting on a tile must navigate panes without triggering a tile launch click
    const launchSpy = vi.spyOn(daemonSocket.daemonApi, "launchMedia");
    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    const animeBtn = screen.getByRole("button", { name: /Anime/i });
    fireEvent.pointerDown(animeBtn, { clientX: 300, clientY: 300 });
    fireEvent.pointerMove(animeBtn, { clientX: 420, clientY: 302 });
    fireEvent.pointerUp(animeBtn, { clientX: 420, clientY: 302 });
    fireEvent.click(animeBtn);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("allows noisy fingertip tap (< 28px drift) to launch media while swipe (>= 28px) navigates without launching", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
    const launchSpy = vi
      .spyOn(daemonSocket.daemonApi, "launchMedia")
      .mockResolvedValue({ ...DEFAULT_DAEMON_SNAPSHOT.media, active_tile_id: "youtube" });
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    vi.stubGlobal("PointerEvent", FakePointerEvent);

    render(<App />);
    await waitFor(() => expect(daemonSocket.daemonApi.fetchState).toHaveBeenCalled());
    const track = screen.getByLabelText("Bedside Hub Panes");

    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    const youtubeBtn = screen.getByRole("button", { name: /YouTube/i });

    // Noisy tap with ~18px diagonal pad roll (< 28px threshold) must still fire onClick
    fireEvent.pointerDown(youtubeBtn, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(youtubeBtn, { pointerId: 1, clientX: 315, clientY: 310 });
    fireEvent.pointerUp(youtubeBtn, { pointerId: 1, clientX: 315, clientY: 310 });
    fireEvent.click(youtubeBtn);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith("youtube");
    await waitFor(() => expect(screen.getByText("Resume")).toBeInTheDocument());
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    // Horizontal swipe (>= 28px and > 1.4 * dy) must navigate without launching media
    launchSpy.mockClear();
    fireEvent.pointerDown(youtubeBtn, { pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(youtubeBtn, { pointerId: 2, clientX: 380, clientY: 305 });
    fireEvent.pointerUp(youtubeBtn, { pointerId: 2, clientX: 380, clientY: 305 });
    fireEvent.click(youtubeBtn);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ignores secondary palm/multi-touch contacts mid-drag and supports fast flicks without intermediate pointermove", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
    const launchSpy = vi
      .spyOn(daemonSocket.daemonApi, "launchMedia")
      .mockResolvedValue({ ...DEFAULT_DAEMON_SNAPSHOT.media, active_tile_id: "youtube" });
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    vi.stubGlobal("PointerEvent", FakePointerEvent);

    render(<App />);
    await waitFor(() => expect(daemonSocket.daemonApi.fetchState).toHaveBeenCalled());
    const track = screen.getByLabelText("Bedside Hub Panes");

    // Multi-touch / palm contact must not hijack active drag or leave transform stuck
    fireEvent.pointerDown(track, { pointerId: 1, isPrimary: true, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(track, { pointerId: 1, isPrimary: true, clientX: 310, clientY: 200 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + -90px), 0, 0)");

    // Secondary touch arrives while pointer 1 is dragging, then lifts first
    fireEvent.pointerDown(track, { pointerId: 2, isPrimary: false, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(track, { pointerId: 2, isPrimary: false, clientX: 50, clientY: 50 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + -90px), 0, 0)");

    // Primary touch completes swipe to Media pane cleanly
    fireEvent.pointerUp(track, { pointerId: 1, isPrimary: true, clientX: 300, clientY: 200 });
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    // Child implicit lostpointercapture bubbling to <main> mid-swipe must NOT abort active drag
    const youtubeBtn = screen.getByRole("button", { name: /YouTube/i });
    fireEvent.pointerDown(youtubeBtn, { pointerId: 4, isPrimary: true, clientX: 300, clientY: 800 });
    fireEvent.pointerMove(youtubeBtn, { pointerId: 4, isPrimary: true, clientX: 335, clientY: 800 });
    // Simulate child losing implicit touch pointer capture when <main> calls setPointerCapture(4)
    fireEvent(youtubeBtn, new FakePointerEvent("lostpointercapture", { bubbles: true, pointerId: 4 }));
    // Subsequent pointermove and pointerup on the swipe must still complete pane navigation
    fireEvent.pointerMove(track, { pointerId: 4, isPrimary: true, clientX: 420, clientY: 800 });
    fireEvent.pointerUp(track, { pointerId: 4, isPrimary: true, clientX: 420, clientY: 800 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");

    // Fast flick on a tile without intermediate pointermove navigates without launching media
    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    fireEvent.pointerDown(youtubeBtn, { pointerId: 3, isPrimary: true, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(youtubeBtn, { pointerId: 3, isPrimary: true, clientX: 360, clientY: 255 });
    fireEvent.click(youtubeBtn);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
