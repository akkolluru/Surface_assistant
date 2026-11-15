"""Ambient Light Sensor (IIO) polling and Smart Night Mode state machine."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from daemon.config import NightModeConfig
from daemon.models import NightModeState

_LOGGER = logging.getLogger(__name__)


class AmbientHardwareBackend(Protocol):
    """Abstraction over Linux sysfs IIO/backlight hardware."""

    def read_lux(self) -> float | None:
        """Read current ambient illuminance in lux, or None if unavailable."""

    def set_backlight_percent(self, percent: int) -> None:
        """Set hardware panel backlight brightness percentage (1-100)."""


class MockAmbientBackend:
    """In-memory mock backend for macOS development and unit tests."""

    def __init__(self, initial_lux: float = 120.0, initial_backlight: int = 65) -> None:
        self.lux: float | None = initial_lux
        self.backlight_percent: int = initial_backlight

    def read_lux(self) -> float | None:
        return self.lux

    def set_backlight_percent(self, percent: int) -> None:
        self.backlight_percent = max(1, min(100, percent))


class LinuxAmbientBackend:
    """Reads Surface IIO ambient light sensor and writes intel_backlight sysfs."""

    def __init__(
        self,
        iio_root: Path = Path("/sys/bus/iio/devices"),
        backlight_root: Path = Path("/sys/class/backlight"),
    ) -> None:
        self._iio_root = iio_root
        self._backlight_root = backlight_root
        self._lux_path: Path | None = None
        self._scale_path: Path | None = None
        self._backlight_dir: Path | None = None

    def _discover_lux_sensor(self) -> Path | None:
        if self._lux_path and self._lux_path.exists():
            return self._lux_path
        if not self._iio_root.exists():
            return None
        for dev in sorted(self._iio_root.glob("iio:device*")):
            raw_file = dev / "in_illuminance_raw"
            if raw_file.exists():
                self._lux_path = raw_file
                scale_file = dev / "in_illuminance_scale"
                self._scale_path = scale_file if scale_file.exists() else None
                return self._lux_path
        return None

    def _discover_backlight(self) -> Path | None:
        if self._backlight_dir and self._backlight_dir.exists():
            return self._backlight_dir
        if not self._backlight_root.exists():
            return None
        preferred = self._backlight_root / "intel_backlight"
        if preferred.exists():
            self._backlight_dir = preferred
            return preferred
        for entry in sorted(self._backlight_root.iterdir()):
            if (entry / "brightness").exists() and (entry / "max_brightness").exists():
                self._backlight_dir = entry
                return entry
        return None

    def read_lux(self) -> float | None:
        lux_file = self._discover_lux_sensor()
        if lux_file is None:
            return None
        try:
            raw = float(lux_file.read_text(encoding="utf-8").strip())
            scale = 1.0
            if self._scale_path is not None and self._scale_path.exists():
                scale = float(self._scale_path.read_text(encoding="utf-8").strip())
            return round(raw * scale, 2)
        except (OSError, ValueError) as err:
            _LOGGER.warning("Failed reading IIO lux sensor: %s", err)
            return None

    def set_backlight_percent(self, percent: int) -> None:
        clamped = max(1, min(100, percent))
        bl_dir = self._discover_backlight()
        if bl_dir is None:
            return
        try:
            max_val = int((bl_dir / "max_brightness").read_text(encoding="utf-8").strip())
            target = max(1, round((clamped / 100.0) * max_val))
            (bl_dir / "brightness").write_text(str(target), encoding="utf-8")
        except (OSError, ValueError) as err:
            _LOGGER.warning("Failed setting backlight brightness: %s", err)


class AmbientNightModeController:
    """Manages Smart Night Mode hysteresis, debounce, video guard, and manual overrides."""

    def __init__(
        self,
        backend: AmbientHardwareBackend,
        config: NightModeConfig,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._backend = backend
        self._config = config
        self._clock = clock
        self._state = NightModeState(backlight_percent=config.day_backlight_percent)
        self._dark_since: float | None = None
        self._bright_since: float | None = None
        self._video_active = False

    @property
    def state(self) -> NightModeState:
        return self._state.model_copy()

    def set_video_active(self, active: bool) -> bool:
        """Update Workspace 2 playback guard; returns True if night mode state changed."""
        self._video_active = active
        if active and self._config.pause_during_video and self._state.enabled:
            if self._state.manual_override is not True:
                return self._apply_night_mode(False, paused_for_video=True)
        if not active and self._state.paused_for_video:
            lux = self._state.lux
            if lux is not None and lux <= self._config.enter_lux:
                return self._apply_night_mode(True, paused_for_video=False)
            self._state.paused_for_video = False
            return True
        return False

    def set_manual_override(self, enabled: bool | None) -> NightModeState:
        """Force night mode on/off, or pass None to resume automatic lux control."""
        self._state.manual_override = enabled
        self._dark_since = None
        self._bright_since = None
        if enabled is not None:
            self._apply_night_mode(enabled, paused_for_video=False)
        else:
            self.poll_once()
        return self.state

    def force_night_mode(self) -> NightModeState:
        """Used by Sleep Timer expiry to engage night mode immediately."""
        self._video_active = False
        return self.set_manual_override(True)

    def poll_once(self) -> bool:
        """Sample lux and transition Night Mode if debounce thresholds are met."""
        lux = self._backend.read_lux()
        changed = lux != self._state.lux
        self._state.lux = lux

        if self._state.manual_override is not None:
            return changed

        if lux is None:
            return changed

        now = self._clock()
        if not self._state.enabled:
            if lux <= self._config.enter_lux:
                self._bright_since = None
                if self._dark_since is None:
                    self._dark_since = now
                elapsed = now - self._dark_since
                if elapsed >= self._config.enter_debounce_seconds:
                    if self._video_active and self._config.pause_during_video:
                        if not self._state.paused_for_video:
                            self._state.paused_for_video = True
                            return True
                        return changed
                    return self._apply_night_mode(True, paused_for_video=False) or changed
            else:
                self._dark_since = None
                if self._state.paused_for_video and lux >= self._config.exit_lux:
                    self._state.paused_for_video = False
                    return True
            return changed

        # Currently in Night Mode
        if lux >= self._config.exit_lux:
            self._dark_since = None
            if self._bright_since is None:
                self._bright_since = now
            if now - self._bright_since >= self._config.exit_debounce_seconds:
                return self._apply_night_mode(False, paused_for_video=False) or changed
        else:
            self._bright_since = None

        return changed

    def _apply_night_mode(self, enabled: bool, *, paused_for_video: bool) -> bool:
        target_bl = (
            self._config.min_backlight_percent
            if enabled
            else self._config.day_backlight_percent
        )
        changed = (
            self._state.enabled != enabled
            or self._state.backlight_percent != target_bl
            or self._state.paused_for_video != paused_for_video
        )
        self._state.enabled = enabled
        self._state.backlight_percent = target_bl
        self._state.paused_for_video = paused_for_video
        self._dark_since = None
        self._bright_since = None
        if changed:
            self._backend.set_backlight_percent(target_bl)
        return changed
