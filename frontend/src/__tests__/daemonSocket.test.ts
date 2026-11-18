import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectDaemonSocket,
  DaemonApiError,
  daemonApi,
  DEFAULT_DAEMON_SNAPSHOT,
} from "../services/daemonSocket";
import type { DaemonEvent } from "../types/hub";

class MockDaemonWebSocket {
  static instances: MockDaemonWebSocket[] = [];
  readonly url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  closeCalls = 0;

  constructor(url: string | URL) {
    this.url = String(url);
    MockDaemonWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.onclose?.({} as CloseEvent);
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }

  emitMessage(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data: raw } as MessageEvent<string>);
  }

  emitError(): void {
    this.onerror?.({} as Event);
  }
}

describe("daemonSocket API client", () => {
  afterEach(() => {
    MockDaemonWebSocket.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws DaemonApiError with server JSON detail on HTTP 500 failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Failed to launch stremio: binary missing" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(daemonApi.launchMedia("stremio")).rejects.toMatchObject({
      name: "DaemonApiError",
      status: 500,
      detail: "Failed to launch stremio: binary missing",
      message: "Failed to launch stremio: binary missing",
      url: "/api/media/launch",
    });

    try {
      await daemonApi.launchMedia("stremio");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonApiError);
    }
  });

  it("falls back to statusText and formatted message when error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Bad Gateway", {
          status: 502,
          statusText: "Bad Gateway",
        })
      )
    );

    await expect(daemonApi.closeMedia()).rejects.toMatchObject({
      name: "DaemonApiError",
      status: 502,
      detail: "Bad Gateway",
      message: "Bad Gateway",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "",
        json: async () => ({}),
      } as unknown as Response)
    );

    await expect(daemonApi.closeMedia()).rejects.toMatchObject({
      name: "DaemonApiError",
      status: 404,
      message: "Daemon request failed (404): /api/media/close",
    });
  });

  it("calls POST /api/media/close and returns MediaState", async () => {
    const expected = {
      active_workspace: "1:hub" as const,
      active_tile_id: null,
      sleep_timer_remaining_seconds: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(expected), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await daemonApi.closeMedia();
    expect(result).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledWith("/api/media/close", {
      method: "POST",
      headers: undefined,
      body: undefined,
    });
  });

  it("propagates network failures as plain errors rather than DaemonApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    let caught: unknown;
    try {
      await daemonApi.launchMedia("youtube");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(DaemonApiError);
  });

  it("fetches daemon snapshot via GET /api/state and throws on non-OK HTTP status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(DEFAULT_DAEMON_SNAPSHOT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await daemonApi.fetchState();
    expect(snapshot).toEqual(DEFAULT_DAEMON_SNAPSHOT);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/state");

    await expect(daemonApi.fetchState()).rejects.toThrow("Failed loading daemon state (503)");
  });

  it("serializes structured JSON detail in DaemonApiError when detail is non-string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: [{ loc: ["body", "minutes"], msg: "invalid" }] }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(daemonApi.setSleepTimer(-5)).rejects.toMatchObject({
      name: "DaemonApiError",
      status: 422,
      detail: JSON.stringify([{ loc: ["body", "minutes"], msg: "invalid" }]),
    });
  });

  it("posts all remaining daemonApi endpoints with expected URLs, payloads, and responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      switch (url) {
        case "/api/media/launch":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.media, active_tile_id: "youtube" }),
            { status: 200 }
          );
        case "/api/media/home":
          return new Response(JSON.stringify(DEFAULT_DAEMON_SNAPSHOT.media), { status: 200 });
        case "/api/wallpapers/next":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.wallpapers, current_index: 1 }),
            { status: 200 }
          );
        case "/api/sleep-timer":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.media, sleep_timer_remaining_seconds: 1800 }),
            { status: 200 }
          );
        case "/api/night-mode":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.night_mode, enabled: true }),
            { status: 200 }
          );
        case "/api/audio/level":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.audio, media_percent: 45 }),
            { status: 200 }
          );
        case "/api/audio/rocker":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.audio, media_percent: 65 }),
            { status: 200 }
          );
        case "/api/knowledge/query":
          return new Response(JSON.stringify({ source: "wikipedia", answer: "Capital city" }), {
            status: 200,
          });
        case "/api/kde/sms":
          return new Response(JSON.stringify({ ok: true, detail: "SMS sent" }), { status: 200 });
        case "/api/kde/reply":
          return new Response(JSON.stringify({ ok: true, detail: "Reply sent" }), { status: 200 });
        case "/api/sim/lux":
          return new Response(
            JSON.stringify({ ...DEFAULT_DAEMON_SNAPSHOT.night_mode, lux: 2, enabled: true }),
            { status: 200 }
          );
        case "/api/sim/sleep-expire":
          return new Response(JSON.stringify(DEFAULT_DAEMON_SNAPSHOT), { status: 200 });
        case "/api/sim/device":
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        default:
          return new Response("Not Found", { status: 404 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(daemonApi.launchMedia("youtube")).resolves.toMatchObject({
      active_tile_id: "youtube",
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/media/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tile_id: "youtube" }),
    });

    await expect(daemonApi.returnHome()).resolves.toEqual(DEFAULT_DAEMON_SNAPSHOT.media);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/media/home", {
      method: "POST",
      headers: undefined,
      body: undefined,
    });

    await expect(daemonApi.nextWallpaper()).resolves.toMatchObject({ current_index: 1 });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/wallpapers/next", {
      method: "POST",
      headers: undefined,
      body: undefined,
    });

    await expect(daemonApi.setSleepTimer(30)).resolves.toMatchObject({
      sleep_timer_remaining_seconds: 1800,
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sleep-timer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 30 }),
    });

    await expect(daemonApi.setNightMode(null)).resolves.toMatchObject({ enabled: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/night-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: null }),
    });

    await expect(
      daemonApi.setAudioLevel("media", { percent: 45, muted: false })
    ).resolves.toMatchObject({ media_percent: 45 });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/audio/level", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "media", percent: 45, muted: false }),
    });

    await expect(daemonApi.pressRocker("up")).resolves.toMatchObject({ media_percent: 65 });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/audio/rocker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "up" }),
    });

    await expect(daemonApi.queryKnowledge("Hyderabad")).resolves.toEqual({
      source: "wikipedia",
      answer: "Capital city",
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/knowledge/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Hyderabad" }),
    });

    await expect(daemonApi.sendMockSms("Mom", "Reached safely")).resolves.toEqual({
      ok: true,
      detail: "SMS sent",
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/kde/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: "Mom", message: "Reached safely" }),
    });

    await expect(daemonApi.replyMockWhatsApp("Alex", "Omw")).resolves.toEqual({
      ok: true,
      detail: "Reply sent",
    });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/kde/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "Alex", message: "Omw" }),
    });

    await expect(daemonApi.setSimLux(2)).resolves.toMatchObject({ lux: 2, enabled: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sim/lux", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lux: 2, instant: true }),
    });

    await expect(daemonApi.setSimLux(120, false)).resolves.toMatchObject({ enabled: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sim/lux", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lux: 120, instant: false }),
    });

    await expect(daemonApi.expireSleepTimer()).resolves.toEqual(DEFAULT_DAEMON_SNAPSHOT);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sim/sleep-expire", {
      method: "POST",
      headers: undefined,
      body: undefined,
    });

    await expect(
      daemonApi.updateSimDevice({ id: "pixel-10", battery_percent: 42, charging: true })
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sim/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pixel-10", battery_percent: 42, charging: true }),
    });
  });

  it("manages connectDaemonSocket lifecycle, message dispatch, exponential reconnect backoff, and cleanup", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockDaemonWebSocket);

    const events: DaemonEvent[] = [];
    const statuses: boolean[] = [];

    const disconnect = connectDaemonSocket({
      onEvent: (ev) => events.push(ev),
      onStatusChange: (connected) => statuses.push(connected),
    });

    expect(MockDaemonWebSocket.instances).toHaveLength(1);
    const ws1 = MockDaemonWebSocket.instances[0]!;
    const expectedProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    expect(ws1.url).toBe(`${expectedProtocol}//${window.location.host}/ws`);

    ws1.emitOpen();
    expect(statuses).toEqual([true]);

    const stateEv: DaemonEvent = { type: "state", payload: DEFAULT_DAEMON_SNAPSHOT };
    const osdEv: DaemonEvent = {
      type: "osd",
      payload: { channel: "media", audio: DEFAULT_DAEMON_SNAPSHOT.audio },
    };
    const toastEv: DaemonEvent = { type: "toast", payload: { message: "SMS sent" } };

    ws1.emitMessage(stateEv);
    ws1.emitMessage(osdEv);
    ws1.emitMessage(toastEv);
    ws1.emitMessage("{malformed-json");
    expect(events).toEqual([stateEv, osdEv, toastEv]);

    // Error triggers close -> status false -> 1000ms reconnect
    ws1.emitError();
    expect(ws1.closeCalls).toBe(1);
    expect(statuses).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(999);
    expect(MockDaemonWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockDaemonWebSocket.instances).toHaveLength(2);

    // Next close doubles backoff to 2000ms, then 4000ms
    MockDaemonWebSocket.instances[1]!.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(MockDaemonWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockDaemonWebSocket.instances).toHaveLength(3);

    // Successful open resets backoff back to 1000ms
    MockDaemonWebSocket.instances[2]!.emitOpen();
    expect(statuses.at(-1)).toBe(true);
    MockDaemonWebSocket.instances[2]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockDaemonWebSocket.instances).toHaveLength(4);

    // Pending timer cleared & close does not schedule reconnect after disconnect()
    MockDaemonWebSocket.instances[3]!.close();
    disconnect();
    await vi.advanceTimersByTimeAsync(20000);
    expect(MockDaemonWebSocket.instances).toHaveLength(4);
  });
});
