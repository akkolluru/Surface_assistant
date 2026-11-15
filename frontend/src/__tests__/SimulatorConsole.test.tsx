import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SimulatorConsole } from "../components/SimulatorConsole";
import * as daemonSocket from "../services/daemonSocket";

describe("SimulatorConsole", () => {
  it("triggers simulated lux drop and sleep timer expiry", async () => {
    vi.spyOn(daemonSocket, "connectDaemonSocket").mockImplementation(() => () => {});
    vi.spyOn(daemonSocket.daemonApi, "fetchState").mockResolvedValue(
      daemonSocket.DEFAULT_DAEMON_SNAPSHOT
    );
    const luxSpy = vi.spyOn(daemonSocket.daemonApi, "setSimLux").mockResolvedValue({
      enabled: true,
      manual_override: null,
      lux: 2,
      backlight_percent: 3,
      paused_for_video: false,
    });
    const sleepSpy = vi
      .spyOn(daemonSocket.daemonApi, "expireSleepTimer")
      .mockResolvedValue(daemonSocket.DEFAULT_DAEMON_SNAPSHOT);

    render(<SimulatorConsole />);
    await waitFor(() => expect(daemonSocket.daemonApi.fetchState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Lights Off/i }));
    await waitFor(() => expect(luxSpy).toHaveBeenCalledWith(2, true));

    fireEvent.click(screen.getByRole("button", { name: /Expire Sleep Timer Now/i }));
    await waitFor(() => expect(sleepSpy).toHaveBeenCalled());

    vi.restoreAllMocks();
  });
});
