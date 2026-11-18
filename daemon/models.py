"""Pydantic schemas shared across daemon REST endpoints and WebSocket events."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

AudioChannel = Literal["alarm", "tts", "media"]
RockerAction = Literal["up", "down", "mute"]
DeviceKind = Literal["phone", "laptop", "tablet"]
MediaKind = Literal["image", "video"]
TileKind = Literal["browser_app", "native_app"]


class NightModeState(BaseModel):
    """Current ambient light & Smart Night Mode state."""

    enabled: bool = False
    manual_override: bool | None = None
    lux: float | None = None
    backlight_percent: int = Field(default=65, ge=1, le=100)
    paused_for_video: bool = False


class AudioState(BaseModel):
    """Independent PipeWire virtual sink levels."""

    alarm_percent: int = Field(default=100, ge=0, le=150)
    tts_percent: int = Field(default=50, ge=0, le=150)
    media_percent: int = Field(default=60, ge=0, le=150)
    alarm_muted: bool = False
    tts_muted: bool = False
    media_muted: bool = False


class MediaTileConfig(BaseModel):
    """Configured Pane 3 video launcher tile."""

    id: str
    label: str
    kind: TileKind
    target: str


class MediaState(BaseModel):
    """Active Sway workspace, running video tile, and sleep timer countdown."""

    active_workspace: Literal["1:hub", "2:media"] = "1:hub"
    active_tile_id: str | None = None
    sleep_timer_remaining_seconds: int | None = None


class ConnectedDevice(BaseModel):
    """KDE Connect device telemetry for DevicePill."""

    id: str
    name: str
    device_type: DeviceKind = "phone"
    reachable: bool = False
    battery_percent: int | None = Field(default=None, ge=0, le=100)
    charging: bool = False


class WeatherState(BaseModel):
    """Open-Meteo weather summary in Celsius."""

    temperature_c: float
    condition_code: int
    condition_label: str
    updated_at: str


class WallpaperItem(BaseModel):
    """Local wallpaper asset exposed safely via HTTP."""

    id: str
    filename: str
    kind: MediaKind
    url: str


class WallpaperState(BaseModel):
    """Current wallpaper rotation state."""

    current_index: int = 0
    interval_seconds: int = 7200
    items: list[WallpaperItem] = Field(default_factory=list)


class DaemonStateSnapshot(BaseModel):
    """Complete daemon state snapshot broadcast to connected Kiosk UI clients."""

    clock_format: Literal["12h", "24h"] = "12h"
    temperature_unit: Literal["C", "F"] = "C"
    night_mode: NightModeState = Field(default_factory=NightModeState)
    audio: AudioState = Field(default_factory=AudioState)
    media: MediaState = Field(default_factory=MediaState)
    devices: list[ConnectedDevice] = Field(default_factory=list)
    weather: WeatherState | None = None
    wallpapers: WallpaperState = Field(default_factory=WallpaperState)
    tiles: list[MediaTileConfig] = Field(default_factory=list)


class DaemonEvent(BaseModel):
    """Typed WebSocket envelope pushed to frontend clients."""

    type: Literal["state", "osd", "toast"]
    payload: dict[str, Any]


class LaunchMediaRequest(BaseModel):
    tile_id: str


class NightModeRequest(BaseModel):
    enabled: bool | None = None


class SleepTimerRequest(BaseModel):
    minutes: int = Field(ge=0, le=180)


class AudioLevelRequest(BaseModel):
    channel: AudioChannel
    percent: int | None = Field(default=None, ge=0, le=150)
    muted: bool | None = None


class RockerRequest(BaseModel):
    action: RockerAction


class SmsRequest(BaseModel):
    recipient: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)


class WhatsAppReplyRequest(BaseModel):
    sender: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)


class KnowledgeQueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)


class KnowledgeQueryResponse(BaseModel):
    source: Literal["wikipedia", "duckduckgo", "open_meteo", "none"]
    answer: str | None
