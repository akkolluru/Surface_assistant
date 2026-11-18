import { afterEach, describe, expect, it, vi } from "vitest";
import { HaClient, PLACEHOLDER_HA_ENTITIES } from "../services/haSocket";
import type { SmartEntityState } from "../types/hub";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState: number = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  closeCalls = 0;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  emitMessage(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data: raw } as MessageEvent<string>);
  }

  emitError(): void {
    this.onerror?.({} as Event);
  }
}

function stubHaConfig(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}

describe("haSocket HaClient", () => {
  afterEach(() => {
    MockWebSocket.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to PLACEHOLDER_HA_ENTITIES when token is missing, placeholder, URL empty, or config fetch fails", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const cases: Array<{ label: string; setup: () => void }> = [
      {
        label: "missing token",
        setup: () => stubHaConfig({ url: "http://127.0.0.1:8123", token: "" }),
      },
      {
        label: "placeholder token",
        setup: () =>
          stubHaConfig({
            url: "http://127.0.0.1:8123",
            token: "replace_with_long_lived_access_token",
          }),
      },
      {
        label: "empty url",
        setup: () => stubHaConfig({ url: "", token: "real-token" }),
      },
      {
        label: "http 503",
        setup: () => stubHaConfig({ detail: "unavailable" }, 503),
      },
      {
        label: "network error",
        setup: () => {
          vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
        },
      },
    ];

    for (const testCase of cases) {
      testCase.setup();
      const onUpdate = vi.fn<(entities: Record<string, SmartEntityState>, live: boolean) => void>();
      const client = new HaClient(onUpdate);

      const cleanup = await client.connect();
      expect(MockWebSocket.instances, testCase.label).toHaveLength(0);
      expect(onUpdate, testCase.label).toHaveBeenCalledTimes(1);
      expect(onUpdate, testCase.label).toHaveBeenCalledWith(PLACEHOLDER_HA_ENTITIES, false);
      cleanup();
    }
  });

  it("updates local placeholder state in offline mode for light, climate, and switch services", () => {
    const updates: Array<{ entities: Record<string, SmartEntityState>; live: boolean }> = [];
    const client = new HaClient((entities, live) => {
      updates.push({ entities, live });
    });

    // Light boolean toggle / turn_on / turn_off + brightness set_value
    client.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.bedroom_main_light",
    });
    expect(updates.at(-1)?.entities["input_boolean.bedroom_main_light"]?.state).toBe("on");
    expect(updates.at(-1)?.live).toBe(false);

    client.callService("input_boolean", "turn_off", {
      entity_id: "input_boolean.bedroom_main_light",
    });
    expect(updates.at(-1)?.entities["input_boolean.bedroom_main_light"]?.state).toBe("off");

    client.callService("input_number", "set_value", {
      entity_id: "input_number.bedroom_light_brightness",
      value: 85,
    });
    expect(updates.at(-1)?.entities["input_number.bedroom_light_brightness"]?.state).toBe("85");

    // Climate power, target temp, and HVAC mode
    client.callService("input_boolean", "turn_on", {
      entity_id: "input_boolean.bedroom_ac_power",
    });
    expect(updates.at(-1)?.entities["input_boolean.bedroom_ac_power"]?.state).toBe("on");

    client.callService("input_number", "set_value", {
      entity_id: "input_number.bedroom_ac_temp",
      value: 21,
    });
    expect(updates.at(-1)?.entities["input_number.bedroom_ac_temp"]?.state).toBe("21");

    client.callService("input_select", "select_option", {
      entity_id: "input_select.bedroom_ac_mode",
      option: "Eco",
    });
    expect(updates.at(-1)?.entities["input_select.bedroom_ac_mode"]?.state).toBe("Eco");

    // Smart plug switches
    client.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.desk_plug",
    });
    expect(updates.at(-1)?.entities["input_boolean.desk_plug"]?.state).toBe("on");

    client.callService("input_boolean", "toggle", {
      entity_id: "input_boolean.fan_plug",
    });
    expect(updates.at(-1)?.entities["input_boolean.fan_plug"]?.state).toBe("on");

    // Scene calls offline do not mutate placeholder entities (scene.* not in PLACEHOLDER_HA_ENTITIES)
    const countBeforeScene = updates.length;
    client.callService("scene", "turn_on", { entity_id: "scene.goodnight" });
    expect(updates).toHaveLength(countBeforeScene);
    // Original PLACEHOLDER_HA_ENTITIES remains unmutated
    expect(PLACEHOLDER_HA_ENTITIES["input_boolean.bedroom_main_light"]?.state).toBe("off");
  });

  it("executes full HA WebSocket handshake, hydration, state_changed events, and callService correlation", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubHaConfig({ url: "https://ha.local:8123/", token: "ha-secret-token" });

    const updates: Array<{ entities: Record<string, SmartEntityState>; live: boolean }> = [];
    const client = new HaClient((entities, live) => {
      updates.push({ entities, live });
    });

    const cleanup = await client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://ha.local:8123/api/websocket");

    // 1. auth_required -> sends auth
    ws.emitMessage({ type: "auth_required", ha_version: "2026.1.0" });
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: "auth",
      access_token: "ha-secret-token",
    });

    // 2. auth_ok -> sends get_states (id=1) + subscribe_events (id=2)
    ws.emitMessage({ type: "auth_ok", ha_version: "2026.1.0" });
    expect(JSON.parse(ws.sent[1]!)).toEqual({ id: 1, type: "get_states" });
    expect(JSON.parse(ws.sent[2]!)).toEqual({
      id: 2,
      type: "subscribe_events",
      event_type: "state_changed",
    });

    // 3. result hydration updates known entities and ignores unmapped ones
    ws.emitMessage({
      id: 1,
      type: "result",
      success: true,
      result: [
        {
          entity_id: "input_boolean.bedroom_main_light",
          state: "on",
          attributes: { friendly_name: "Bedroom Ceiling Light" },
        },
        {
          entity_id: "input_number.bedroom_ac_temp",
          state: "22",
          attributes: { min: 18, max: 30, step: 1 },
        },
        {
          entity_id: "sensor.ignored_outdoor",
          state: "99",
          attributes: {},
        },
      ],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.live).toBe(true);
    expect(updates[0]?.entities["input_boolean.bedroom_main_light"]?.state).toBe("on");
    expect(updates[0]?.entities["input_number.bedroom_ac_temp"]?.state).toBe("22");
    expect(updates[0]?.entities["sensor.ignored_outdoor"]).toBeUndefined();

    // 4. callService sends correlated sequential IDs (id=3, id=4) and handles result + state_changed
    client.callService("input_select", "select_option", {
      entity_id: "input_select.bedroom_ac_mode",
      option: "Dry",
    });
    client.callService("scene", "turn_on", {
      entity_id: "scene.goodnight",
    });

    expect(JSON.parse(ws.sent[3]!)).toEqual({
      id: 3,
      type: "call_service",
      domain: "input_select",
      service: "select_option",
      service_data: {
        entity_id: "input_select.bedroom_ac_mode",
        option: "Dry",
      },
    });
    expect(JSON.parse(ws.sent[4]!)).toEqual({
      id: 4,
      type: "call_service",
      domain: "scene",
      service: "turn_on",
      service_data: {
        entity_id: "scene.goodnight",
      },
    });

    // Non-array call_service result ack is ignored cleanly
    ws.emitMessage({
      id: 3,
      type: "result",
      success: true,
      result: { context: { id: "ctx-3" } },
    });
    expect(updates).toHaveLength(1);

    // Malformed JSON frame is ignored without throwing
    ws.emitMessage("{bad-json");
    expect(updates).toHaveLength(1);

    // state_changed event updates entity and triggers live update
    ws.emitMessage({
      id: 2,
      type: "event",
      event: {
        data: {
          entity_id: "input_select.bedroom_ac_mode",
          new_state: { state: "Dry", attributes: { options: ["Cool", "Dry", "Fan", "Eco"] } },
        },
      },
    });
    expect(updates).toHaveLength(2);
    expect(updates[1]?.live).toBe(true);
    expect(updates[1]?.entities["input_select.bedroom_ac_mode"]?.state).toBe("Dry");

    cleanup();
    expect(ws.closeCalls).toBe(1);
    expect(updates.at(-1)?.live).toBe(false);
  });

  it("stops retrying on auth_invalid and uses exponential backoff on unexpected disconnects until disposed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    stubHaConfig({ url: "http://127.0.0.1:8123", token: "bad-token" });

    const onUpdate = vi.fn<(entities: Record<string, SmartEntityState>, live: boolean) => void>();
    const client = new HaClient(onUpdate);

    const cleanupAuthInvalid = await client.connect();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.emitMessage({ type: "auth_invalid", message: "Invalid access token" });

    expect(ws1.closeCalls).toBe(1);
    expect(onUpdate).toHaveBeenCalledWith(PLACEHOLDER_HA_ENTITIES, false);

    await vi.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
    cleanupAuthInvalid();

    // Now test reconnect backoff on unexpected error/close
    MockWebSocket.instances = [];
    stubHaConfig({ url: "http://127.0.0.1:8123", token: "valid-token" });
    const cleanupRetry = await client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0]!.emitError();
    expect(MockWebSocket.instances[0]!.closeCalls).toBe(1);

    // First retry after 1500ms
    await vi.advanceTimersByTimeAsync(1499);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second retry after 3000ms
    MockWebSocket.instances[1]!.close();
    await vi.advanceTimersByTimeAsync(2999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Cleanup prevents any further reconnects
    cleanupRetry();
    await vi.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });
});
