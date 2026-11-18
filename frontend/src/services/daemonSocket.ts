import type {
  AudioChannel,
  AudioState,
  DaemonEvent,
  DaemonStateSnapshot,
  MediaState,
  NightModeState,
  WallpaperState,
} from "../types/hub";

export const DEFAULT_DAEMON_SNAPSHOT: DaemonStateSnapshot = {
  clock_format: "12h",
  temperature_unit: "C",
  night_mode: {
    enabled: false,
    manual_override: null,
    lux: 120,
    backlight_percent: 65,
    paused_for_video: false,
  },
  audio: {
    alarm_percent: 100,
    tts_percent: 50,
    media_percent: 60,
    alarm_muted: false,
    tts_muted: false,
    media_muted: false,
  },
  media: {
    active_workspace: "1:hub",
    active_tile_id: null,
    sleep_timer_remaining_seconds: null,
  },
  devices: [],
  weather: null,
  wallpapers: {
    current_index: 0,
    interval_seconds: 180,
    items: [],
  },
  tiles: [
    { id: "youtube", label: "YouTube", kind: "browser_app", target: "https://www.youtube.com" },
    { id: "netflix", label: "Netflix", kind: "browser_app", target: "https://www.netflix.com" },
    { id: "prime", label: "Prime Video", kind: "browser_app", target: "https://www.primevideo.com" },
    { id: "anime", label: "Anime", kind: "browser_app", target: "https://example.com" },
    { id: "stremio", label: "Stremio", kind: "native_app", target: "stremio" },
  ],
};

/** Typed HTTP error thrown when the hardware daemon returns a non-2xx response. */
export class DaemonApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly url: string;

  constructor(status: number, detail: string, url: string) {
    const resolvedMessage = detail || `Daemon request failed (${status}): ${url}`;
    super(resolvedMessage);
    this.name = "DaemonApiError";
    this.status = status;
    this.detail = detail || resolvedMessage;
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function parseDaemonErrorDetail(response: Response): Promise<string> {
  if (typeof response.json === "function") {
    try {
      const payload = (await response.json()) as { detail?: unknown } | null;
      if (payload && typeof payload === "object" && "detail" in payload) {
        if (typeof payload.detail === "string" && payload.detail.trim().length > 0) {
          return payload.detail.trim();
        }
        if (payload.detail !== undefined && payload.detail !== null) {
          return JSON.stringify(payload.detail);
        }
      }
    } catch {
      // Non-JSON or empty error response; fall back to HTTP status text.
    }
  }
  return typeof response.statusText === "string" ? response.statusText.trim() : "";
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await parseDaemonErrorDetail(response);
    throw new DaemonApiError(response.status, detail, url);
  }
  return (await response.json()) as T;
}

export const daemonApi = {
  fetchState: async (): Promise<DaemonStateSnapshot> => {
    const response = await fetch("/api/state");
    if (!response.ok) {
      throw new Error(`Failed loading daemon state (${response.status})`);
    }
    return (await response.json()) as DaemonStateSnapshot;
  },
  launchMedia: (tileId: string): Promise<MediaState> =>
    postJson<MediaState>("/api/media/launch", { tile_id: tileId }),
  closeMedia: (): Promise<MediaState> => postJson<MediaState>("/api/media/close"),
  returnHome: (): Promise<MediaState> => postJson<MediaState>("/api/media/home"),
  nextWallpaper: (): Promise<WallpaperState> => postJson<WallpaperState>("/api/wallpapers/next"),
  setSleepTimer: (minutes: number): Promise<MediaState> =>
    postJson<MediaState>("/api/sleep-timer", { minutes }),
  setNightMode: (enabled: boolean | null): Promise<NightModeState> =>
    postJson<NightModeState>("/api/night-mode", { enabled }),
  setAudioLevel: (
    channel: AudioChannel,
    payload: { percent?: number; muted?: boolean }
  ): Promise<AudioState> => postJson<AudioState>("/api/audio/level", { channel, ...payload }),
  pressRocker: (action: "up" | "down" | "mute"): Promise<AudioState> =>
    postJson<AudioState>("/api/audio/rocker", { action }),
  queryKnowledge: (query: string): Promise<{ source: string; answer: string | null }> =>
    postJson<{ source: string; answer: string | null }>("/api/knowledge/query", { query }),
  sendMockSms: (recipient: string, message: string): Promise<{ ok: boolean; detail: string }> =>
    postJson<{ ok: boolean; detail: string }>("/api/kde/sms", { recipient, message }),
  replyMockWhatsApp: (sender: string, message: string): Promise<{ ok: boolean; detail: string }> =>
    postJson<{ ok: boolean; detail: string }>("/api/kde/reply", { sender, message }),
  setSimLux: (lux: number, instant = true): Promise<NightModeState> =>
    postJson<NightModeState>("/api/sim/lux", { lux, instant }),
  expireSleepTimer: (): Promise<DaemonStateSnapshot> =>
    postJson<DaemonStateSnapshot>("/api/sim/sleep-expire"),
  updateSimDevice: (payload: {
    id: string;
    battery_percent?: number;
    charging?: boolean;
    reachable?: boolean;
  }): Promise<unknown> => postJson("/api/sim/device", payload),
};

export interface DaemonSocketHandlers {
  onEvent: (event: DaemonEvent) => void;
  onStatusChange?: (connected: boolean) => void;
}

export function connectDaemonSocket(handlers: DaemonSocketHandlers): () => void {
  let disposed = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let retryMs = 1000;

  const scheduleReconnect = () => {
    if (disposed) return;
    retryTimer = window.setTimeout(() => {
      retryMs = Math.min(10000, retryMs * 2);
      open();
    }, retryMs);
  };

  const open = () => {
    if (disposed) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      retryMs = 1000;
      handlers.onStatusChange?.(true);
    };

    socket.onmessage = (msgEvent) => {
      try {
        const parsed = JSON.parse(String(msgEvent.data)) as DaemonEvent;
        handlers.onEvent(parsed);
      } catch {
        // Ignore malformed frame
      }
    };

    socket.onerror = () => {
      socket?.close();
    };

    socket.onclose = () => {
      handlers.onStatusChange?.(false);
      scheduleReconnect();
    };
  };

  open();

  return () => {
    disposed = true;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
    }
    socket?.close();
  };
}
