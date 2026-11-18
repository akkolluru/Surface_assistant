import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { AmbientHubPane } from "../components/AmbientHubPane";
import { DevicePill } from "../components/DevicePill";
import { MediaLauncher } from "../components/MediaLauncher";
import { SmartHomePane } from "../components/SmartHomePane";
import { VolumeOSD } from "../components/VolumeOSD";
import * as daemonSocket from "../services/daemonSocket";
import { DEFAULT_DAEMON_SNAPSHOT } from "../services/daemonSocket";
import { PLACEHOLDER_HA_ENTITIES } from "../services/haSocket";
import type { MediaTileConfig } from "../types/hub";

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  isPrimary: boolean;
  pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
    this.pointerType = init.pointerType ?? "touch";
  }
}

function makeTiles(count: number): MediaTileConfig[] {
  const catalog = DEFAULT_DAEMON_SNAPSHOT.tiles;
  return Array.from({ length: count }, (_, idx) => {
    const preset = catalog[idx];
    if (preset) {
      return preset;
    }
    return {
      id: `custom-${idx + 1}`,
      label: `Channel ${idx + 1}`,
      kind: "browser_app",
      target: `https://example.com/${idx + 1}`,
    };
  });
}

describe("Surface Assistant Kiosk UI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  it("supports 2-tap preview vs 1-tap launch and preserves active session indicators", () => {
    const onLaunch = vi.fn();
    const { unmount } = render(
      <MediaLauncher
        tiles={DEFAULT_DAEMON_SNAPSHOT.tiles}
        activeTileId={null}
        onLaunchTile={onLaunch}
        onNavigateHub={vi.fn()}
      />
    );

    // activeTileId={null} starts centered on YouTube without Now Playing
    expect(screen.getByRole("heading", { level: 2, name: "YouTube" })).toBeInTheDocument();
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.queryByText("Now Playing")).not.toBeInTheDocument();

    // Tap off-center Anime medallion -> previews Anime in hologram without launching
    fireEvent.click(screen.getByRole("button", { name: "Select Anime" }));
    expect(screen.getByRole("heading", { level: 2, name: "Anime" })).toBeInTheDocument();
    expect(onLaunch).not.toHaveBeenCalled();

    // Tap centered Anime medallion -> launches Anime once
    fireEvent.click(screen.getByRole("button", { name: "Launch Anime" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith("anime");

    // Step with '>' ghost chevron -> previews Stremio without launching
    fireEvent.click(screen.getByRole("button", { name: "Next media service" }));
    expect(screen.getByRole("heading", { level: 2, name: "Stremio" })).toBeInTheDocument();
    expect(onLaunch).toHaveBeenCalledTimes(1);

    unmount();

    // activeTileId="netflix" starts centered on Netflix with Now Playing + Resume
    const onLaunchRunning = vi.fn();
    render(
      <MediaLauncher
        tiles={DEFAULT_DAEMON_SNAPSHOT.tiles}
        activeTileId="netflix"
        onLaunchTile={onLaunchRunning}
        onNavigateHub={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { level: 2, name: "Netflix" })).toBeInTheDocument();
    expect(screen.getByText("Now Playing")).toBeInTheDocument();
    expect(screen.getByText("Resume")).toBeInTheDocument();

    // Stepping to YouTube hides Now Playing while preserving off-center Netflix running status
    fireEvent.click(screen.getByRole("button", { name: "Select YouTube" }));
    expect(screen.getByRole("heading", { level: 2, name: "YouTube" })).toBeInTheDocument();
    expect(screen.queryByText("Now Playing")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select Netflix (currently playing)" })
    ).toBeInTheDocument();
    expect(onLaunchRunning).not.toHaveBeenCalled();
  });

  it("handles edge-case tile counts (N = 0, 3, 4, 5, 8) safely under jsdom zero-rect layout", () => {
    const onNavigateHub = vi.fn();
    const { unmount } = render(
      <MediaLauncher
        tiles={[]}
        activeTileId={null}
        onLaunchTile={vi.fn()}
        onNavigateHub={onNavigateHub}
      />
    );

    expect(screen.getByText("No media apps configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to Ambient Hub" }));
    expect(onNavigateHub).toHaveBeenCalledTimes(1);
    unmount();

    // N = 3 centers tiles[1] and disables flanking chevrons at bounded endpoints
    const threeTiles = makeTiles(3);
    const threeView = render(
      <MediaLauncher
        tiles={threeTiles}
        activeTileId={null}
        onLaunchTile={vi.fn()}
        onNavigateHub={vi.fn()}
      />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Netflix" })).toBeInTheDocument();
    const prevBtn = screen.getByRole("button", { name: "Previous media service" });
    const nextBtn = screen.getByRole("button", { name: "Next media service" });
    expect(prevBtn).not.toBeDisabled();
    expect(nextBtn).not.toBeDisabled();

    fireEvent.click(prevBtn);
    expect(screen.getByRole("heading", { level: 2, name: "YouTube" })).toBeInTheDocument();
    expect(prevBtn).toBeDisabled();

    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);
    expect(screen.getByRole("heading", { level: 2, name: "Prime Video" })).toBeInTheDocument();
    expect(nextBtn).toBeDisabled();
    threeView.unmount();

    // N = 4, 5, 8 render with zero NaN transforms/styles and N = 8 hides slots past 96°
    for (const count of [4, 5, 8]) {
      const view = render(
        <MediaLauncher
          tiles={makeTiles(count)}
          activeTileId={null}
          onLaunchTile={vi.fn()}
          onNavigateHub={vi.fn()}
        />
      );
      const group = screen.getByRole("group", { name: "Media service dial" });
      const slotWrappers = Array.from(group.children) as HTMLElement[];
      expect(slotWrappers).toHaveLength(count);
      for (const wrapper of slotWrappers) {
        expect(wrapper.getAttribute("style") ?? "").not.toContain("NaN");
        expect(wrapper.style.transform).not.toContain("NaN");
      }
      if (count === 8) {
        const hiddenCount = slotWrappers.filter(
          (el) =>
            el.style.visibility === "hidden" &&
            Number(el.style.opacity) === 0 &&
            el.style.pointerEvents === "none"
        ).length;
        expect(hiddenCount).toBeGreaterThan(0);
      }
      view.unmount();
    }
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

  it("slides smoothly between panes via navigation dots and open-deck pointer swipe", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
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

    // Swiping starting on the open deck (< Hub button outside [data-dial-ring]) navigates without firing click
    const launchSpy = vi.spyOn(daemonSocket.daemonApi, "launchMedia");
    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    const hubBtn = screen.getByRole("button", { name: "Return to Ambient Hub" });
    fireEvent.pointerDown(hubBtn, { pointerId: 10, clientX: 120, clientY: 700 });
    fireEvent.pointerMove(hubBtn, { pointerId: 10, clientX: 240, clientY: 702 });
    fireEvent.pointerUp(hubBtn, { pointerId: 10, clientX: 240, clientY: 702 });
    const clickAllowed = fireEvent.click(hubBtn);
    expect(clickAllowed).toBe(false);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");
  });

  it("allows 18px noisy fingertip tap on centered medallion to launch while >= 22px dial drag spins without launching or swiping panes", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
    const launchSpy = vi
      .spyOn(daemonSocket.daemonApi, "launchMedia")
      .mockResolvedValue({ ...DEFAULT_DAEMON_SNAPSHOT.media, active_tile_id: "youtube" });
    vi.stubGlobal("PointerEvent", FakePointerEvent);

    const { container } = render(<App />);
    await waitFor(() => expect(daemonSocket.daemonApi.fetchState).toHaveBeenCalled());
    const track = screen.getByLabelText("Bedside Hub Panes");

    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    const youtubeBtn = screen.getByRole("button", { name: "Launch YouTube" });

    // Noisy tap with ~18px diagonal pad roll (dx=15, dy=10 < 22px dial & 28px pane thresholds) launches media
    fireEvent.pointerDown(youtubeBtn, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(youtubeBtn, { pointerId: 1, clientX: 315, clientY: 310 });
    fireEvent.pointerUp(youtubeBtn, { pointerId: 1, clientX: 315, clientY: 310 });
    fireEvent.click(youtubeBtn);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith("youtube");
    await waitFor(() => expect(screen.getByText("Now Playing")).toBeInTheDocument());
    expect(screen.getByText("Resume")).toBeInTheDocument();
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    // >= 22px drag on centered medallion spins dial, suppresses click via onClickCapture, and stays on Pane 2
    launchSpy.mockClear();
    const resumeYoutubeBtn = screen.getByRole("button", { name: "Resume YouTube" });
    fireEvent.pointerDown(resumeYoutubeBtn, { pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(resumeYoutubeBtn, { pointerId: 2, clientX: 120, clientY: 300 });
    fireEvent.pointerUp(resumeYoutubeBtn, { pointerId: 2, clientX: 120, clientY: 300 });
    const medallionClickAllowed = fireEvent.click(resumeYoutubeBtn);

    expect(medallionClickAllowed).toBe(false);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");
    expect(screen.getByRole("heading", { level: 2, name: "Netflix" })).toBeInTheDocument();

    // >= 22px scrub drag on invisible annular <path data-dial-ring> also spins dial and stays on Pane 2
    const scrubPath = container.querySelector("path[data-dial-ring]");
    expect(scrubPath).not.toBeNull();
    fireEvent.pointerDown(scrubPath!, { pointerId: 3, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(scrubPath!, { pointerId: 3, clientX: 480, clientY: 300 });
    fireEvent.pointerUp(scrubPath!, { pointerId: 3, clientX: 480, clientY: 300 });

    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");
    expect(screen.getByRole("heading", { level: 2, name: "YouTube" })).toBeInTheDocument();
  });

  it("isolates dial arrow keys inside role='group' while allowing Hub ArrowLeft pane navigation", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);

    render(<App />);
    await waitFor(() => expect(daemonSocket.daemonApi.fetchState).toHaveBeenCalled());
    const track = screen.getByLabelText("Bedside Hub Panes");

    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    const youtubeBtn = screen.getByRole("button", { name: "Launch YouTube" });
    youtubeBtn.focus();
    expect(document.activeElement).toBe(youtubeBtn);

    fireEvent.keyDown(youtubeBtn, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { level: 2, name: "Netflix" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Launch Netflix" }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("heading", { level: 2, name: "Stremio" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Launch Stremio" }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("heading", { level: 2, name: "YouTube" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Launch YouTube" }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { level: 2, name: "Stremio" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Launch Stremio" }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");

    // ArrowLeft when focused on < Hub outside the dial group navigates back to Hub (-100vw)
    const hubBtn = screen.getByRole("button", { name: "Return to Ambient Hub" });
    hubBtn.focus();
    fireEvent.keyDown(hubBtn, { key: "ArrowLeft" });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");
  });

  it("ignores secondary palm/multi-touch contacts mid-drag and supports open-deck lostpointercapture & fast flicks", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(DEFAULT_DAEMON_SNAPSHOT);
    const launchSpy = vi
      .spyOn(daemonSocket.daemonApi, "launchMedia")
      .mockResolvedValue({ ...DEFAULT_DAEMON_SNAPSHOT.media, active_tile_id: "youtube" });
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

    // Child implicit lostpointercapture bubbling from open-deck control (< Hub) must NOT abort pane swipe
    const hubBtn = screen.getByRole("button", { name: "Return to Ambient Hub" });
    fireEvent.pointerDown(hubBtn, { pointerId: 4, isPrimary: true, clientX: 120, clientY: 700 });
    fireEvent.pointerMove(hubBtn, { pointerId: 4, isPrimary: true, clientX: 155, clientY: 700 });
    fireEvent(hubBtn, new FakePointerEvent("lostpointercapture", { bubbles: true, pointerId: 4 }));
    fireEvent.pointerMove(track, { pointerId: 4, isPrimary: true, clientX: 240, clientY: 700 });
    fireEvent.pointerUp(track, { pointerId: 4, isPrimary: true, clientX: 240, clientY: 700 });
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");

    // Fast flick on open deck (<section> outside [data-dial-ring]) navigates back without launching media
    fireEvent.click(screen.getByRole("button", { name: /Go to Bedside Theater/i }));
    expect(track.style.transform).toBe("translate3d(calc(-200vw + 0px), 0, 0)");
    const mediaSection = screen.getByRole("region", { name: "Bedside Video Launcher" });
    fireEvent.pointerDown(mediaSection, { pointerId: 3, isPrimary: true, clientX: 250, clientY: 320 });
    fireEvent.pointerUp(mediaSection, { pointerId: 3, isPrimary: true, clientX: 360, clientY: 325 });

    expect(launchSpy).not.toHaveBeenCalled();
    expect(track.style.transform).toBe("translate3d(calc(-100vw + 0px), 0, 0)");
  });
});
