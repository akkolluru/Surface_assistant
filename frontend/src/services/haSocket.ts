import type { SmartEntityState } from "../types/hub";

export const PLACEHOLDER_HA_ENTITIES: Record<string, SmartEntityState> = {
  "input_boolean.bedroom_main_light": {
    entityId: "input_boolean.bedroom_main_light",
    label: "Ceiling Light",
    state: "off",
    attributes: {},
  },
  "input_number.bedroom_light_brightness": {
    entityId: "input_number.bedroom_light_brightness",
    label: "Ceiling Brightness",
    state: "60",
    attributes: { min: 5, max: 100, step: 5, unit_of_measurement: "%" },
  },
  "input_boolean.bedside_lamp": {
    entityId: "input_boolean.bedside_lamp",
    label: "Bedside Warm Lamp",
    state: "off",
    attributes: {},
  },
  "input_boolean.bedroom_ac_power": {
    entityId: "input_boolean.bedroom_ac_power",
    label: "Bedroom AC",
    state: "off",
    attributes: {},
  },
  "input_number.bedroom_ac_temp": {
    entityId: "input_number.bedroom_ac_temp",
    label: "AC Target",
    state: "24",
    attributes: { min: 18, max: 30, step: 1, unit_of_measurement: "°C" },
  },
  "input_select.bedroom_ac_mode": {
    entityId: "input_select.bedroom_ac_mode",
    label: "AC Mode",
    state: "Cool",
    attributes: { options: ["Cool", "Dry", "Fan", "Eco"] },
  },
  "input_boolean.desk_plug": {
    entityId: "input_boolean.desk_plug",
    label: "Desk Smart Plug",
    state: "off",
    attributes: {},
  },
  "input_boolean.fan_plug": {
    entityId: "input_boolean.fan_plug",
    label: "Standing Fan Plug",
    state: "off",
    attributes: {},
  },
};

interface HaSocketMessage {
  id?: number;
  type: string;
  event?: { data?: { entity_id?: string; new_state?: { state: string; attributes: Record<string, unknown> } } };
  result?: Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
}

export class HaClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private connected = false;
  private entities: Record<string, SmartEntityState> = { ...PLACEHOLDER_HA_ENTITIES };
  private onUpdate: (entities: Record<string, SmartEntityState>, live: boolean) => void;

  constructor(onUpdate: (entities: Record<string, SmartEntityState>, live: boolean) => void) {
    this.onUpdate = onUpdate;
  }

  async connect(): Promise<() => void> {
    let disposed = false;
    try {
      const resp = await fetch("/api/ha-config");
      if (!resp.ok) {
        this.onUpdate(this.entities, false);
        return () => {
          disposed = true;
        };
      }
      const cfg = (await resp.json()) as { url: string; token: string };
      if (!cfg.token || disposed) {
        this.onUpdate(this.entities, false);
        return () => {
          disposed = true;
        };
      }

      const wsUrl = cfg.url.replace(/^http/, "ws") + "/api/websocket";
      const ws = new WebSocket(wsUrl);
      this.socket = ws;

      ws.onmessage = (event) => {
        if (disposed) return;
        const msg = JSON.parse(String(event.data)) as HaSocketMessage;
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: cfg.token }));
          return;
        }
        if (msg.type === "auth_ok") {
          this.connected = true;
          ws.send(JSON.stringify({ id: this.nextId++, type: "get_states" }));
          ws.send(
            JSON.stringify({
              id: this.nextId++,
              type: "subscribe_events",
              event_type: "state_changed",
            })
          );
          return;
        }
        if (msg.type === "result" && Array.isArray(msg.result)) {
          const next = { ...this.entities };
          for (const item of msg.result) {
            if (item.entity_id in next) {
              const existing = next[item.entity_id];
              if (existing) {
                next[item.entity_id] = {
                  ...existing,
                  state: item.state,
                  attributes: item.attributes,
                };
              }
            }
          }
          this.entities = next;
          this.onUpdate(this.entities, true);
          return;
        }
        if (msg.type === "event" && msg.event?.data?.entity_id && msg.event.data.new_state) {
          const eid = msg.event.data.entity_id;
          const existing = this.entities[eid];
          if (existing) {
            this.entities = {
              ...this.entities,
              [eid]: {
                ...existing,
                state: msg.event.data.new_state.state,
                attributes: msg.event.data.new_state.attributes,
              },
            };
            this.onUpdate(this.entities, true);
          }
        }
      };

      ws.onclose = () => {
        this.connected = false;
        this.onUpdate(this.entities, false);
      };
    } catch {
      this.onUpdate(this.entities, false);
    }

    return () => {
      disposed = true;
      this.socket?.close();
    };
  }

  callService(domain: string, service: string, data: Record<string, unknown>): void {
    const entityId = typeof data["entity_id"] === "string" ? data["entity_id"] : null;
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          id: this.nextId++,
          type: "call_service",
          domain,
          service,
          service_data: data,
        })
      );
      return;
    }

    // Placeholder / local Mac mode updates UI state deterministically so cards remain interactive
    if (entityId && entityId in this.entities) {
      const current = this.entities[entityId];
      if (!current) return;
      let nextState = current.state;
      if (service === "toggle") {
        nextState = current.state === "on" ? "off" : "on";
      } else if (service === "turn_on") {
        nextState = "on";
      } else if (service === "turn_off") {
        nextState = "off";
      } else if (service === "set_value" && data["value"] !== undefined) {
        nextState = String(data["value"]);
      } else if (service === "select_option" && data["option"] !== undefined) {
        nextState = String(data["option"]);
      }
      this.entities = {
        ...this.entities,
        [entityId]: { ...current, state: nextState },
      };
      this.onUpdate(this.entities, false);
    }
  }
}
