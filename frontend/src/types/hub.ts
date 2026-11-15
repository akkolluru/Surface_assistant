export type AudioChannel = "alarm" | "tts" | "media";
export type DeviceKind = "phone" | "laptop" | "tablet";
export type MediaKind = "image" | "video";
export type TileKind = "browser_app" | "native_app";

export interface NightModeState {
  enabled: boolean;
  manual_override: boolean | null;
  lux: number | null;
  backlight_percent: number;
  paused_for_video: boolean;
}

export interface AudioState {
  alarm_percent: number;
  tts_percent: number;
  media_percent: number;
  alarm_muted: boolean;
  tts_muted: boolean;
  media_muted: boolean;
}

export interface MediaTileConfig {
  id: string;
  label: string;
  kind: TileKind;
  target: string;
}

export interface MediaState {
  active_workspace: "1:hub" | "2:media";
  active_tile_id: string | null;
  sleep_timer_remaining_seconds: number | null;
}

export interface ConnectedDevice {
  id: string;
  name: string;
  device_type: DeviceKind;
  reachable: boolean;
  battery_percent: number | null;
  charging: boolean;
}

export interface WeatherState {
  temperature_c: number;
  condition_code: number;
  condition_label: string;
  updated_at: string;
}

export interface WallpaperItem {
  id: string;
  filename: string;
  kind: MediaKind;
  url: string;
}

export interface WallpaperState {
  current_index: number;
  interval_seconds: number;
  items: WallpaperItem[];
}

export interface DaemonStateSnapshot {
  clock_format: "12h" | "24h";
  temperature_unit: "C" | "F";
  night_mode: NightModeState;
  audio: AudioState;
  media: MediaState;
  devices: ConnectedDevice[];
  weather: WeatherState | null;
  wallpapers: WallpaperState;
  tiles: MediaTileConfig[];
}

export type DaemonEvent =
  | { type: "state"; payload: DaemonStateSnapshot }
  | { type: "osd"; payload: { channel: AudioChannel; audio: AudioState } }
  | { type: "toast"; payload: { message: string } };

export interface SmartEntityState {
  entityId: string;
  label: string;
  state: string;
  attributes: Record<string, unknown>;
}
