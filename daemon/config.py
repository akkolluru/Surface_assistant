"""Configuration loader combining .env settings and config.yaml defaults."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from daemon.models import MediaTileConfig

REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")


class NightModeConfig(BaseModel):
    enter_lux: float = 5.0
    exit_lux: float = 15.0
    enter_debounce_seconds: float = 10.0
    exit_debounce_seconds: float = 5.0
    min_backlight_percent: int = Field(default=3, ge=1, le=20)
    day_backlight_percent: int = Field(default=65, ge=10, le=100)
    pause_during_video: bool = True


class DisplayConfig(BaseModel):
    clock_format: Literal["12h", "24h"] = "12h"
    temperature_unit: Literal["C", "F"] = "C"
    wallpaper_interval_seconds: int = 180
    night_mode: NightModeConfig = Field(default_factory=NightModeConfig)


class AudioDefaultsConfig(BaseModel):
    alarm_sink_percent: int = 100
    tts_sink_percent: int = 50
    media_sink_percent: int = 60


class LauncherConfig(BaseModel):
    browser_bin: str = "brave-browser"
    tiles: list[MediaTileConfig] = Field(default_factory=list)


class AppYamlConfig(BaseModel):
    display: DisplayConfig = Field(default_factory=DisplayConfig)
    audio_defaults: AudioDefaultsConfig = Field(default_factory=AudioDefaultsConfig)
    launcher: LauncherConfig = Field(default_factory=LauncherConfig)


class EnvSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ha_url: str = "http://127.0.0.1:8123"
    ha_token: str = ""
    daemon_host: str = "127.0.0.1"
    daemon_port: int = 8000
    hardware_backend: Literal["auto", "mock", "linux"] = "auto"
    weather_lat: float = 17.3850
    weather_lon: float = 78.4867
    weather_timezone: str = "Asia/Kolkata"
    wallpapers_dir: str = "~/wallpapers"
    anime_portal_url: str = "https://example.com"


class AppConfig(BaseModel):
    env: EnvSettings
    yaml_cfg: AppYamlConfig
    resolved_backend: Literal["mock", "linux"]
    wallpapers_path: Path
    frontend_dist_path: Path


def _expand_env_vars(raw: str, env_values: dict[str, str]) -> str:
    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        return env_values.get(key, os.environ.get(key, match.group(0)))

    return _ENV_PATTERN.sub(_replace, raw)


def load_config(
    config_path: Path | None = None,
    env_settings: EnvSettings | None = None,
) -> AppConfig:
    """Load merged .env and YAML configuration with safe fallback to config.example.yaml."""
    env = env_settings or EnvSettings()
    env_map = {
        "ANIME_PORTAL_URL": env.anime_portal_url,
        "WALLPAPERS_DIR": env.wallpapers_dir,
    }

    target_yaml = config_path or (REPO_ROOT / "config.yaml")
    if not target_yaml.exists():
        target_yaml = REPO_ROOT / "config.example.yaml"

    parsed: dict[str, object] = {}
    if target_yaml.exists():
        raw_text = _expand_env_vars(target_yaml.read_text(encoding="utf-8"), env_map)
        loaded = yaml.safe_load(raw_text)
        if isinstance(loaded, dict):
            parsed = loaded

    audio_section = parsed.get("audio")
    if isinstance(audio_section, dict) and "defaults" in audio_section:
        parsed["audio_defaults"] = audio_section["defaults"]

    yaml_cfg = AppYamlConfig.model_validate(parsed)

    if env.hardware_backend == "auto":
        resolved_backend: Literal["mock", "linux"] = (
            "linux" if sys.platform.startswith("linux") else "mock"
        )
    else:
        resolved_backend = env.hardware_backend

    return AppConfig(
        env=env,
        yaml_cfg=yaml_cfg,
        resolved_backend=resolved_backend,
        wallpapers_path=Path(env.wallpapers_dir).expanduser(),
        frontend_dist_path=REPO_ROOT / "frontend" / "dist",
    )
