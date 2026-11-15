"""Sway compositor IPC, single-window video launcher, MPRIS pause, and sleep timer."""

from __future__ import annotations

import logging
import subprocess
import time
from collections.abc import Callable
from typing import Literal, Protocol

from daemon.ambient_light import AmbientNightModeController
from daemon.models import MediaState, MediaTileConfig

_LOGGER = logging.getLogger(__name__)


class CompositorBackend(Protocol):
    """Abstraction over Sway Wayland IPC + MPRIS player control."""

    def launch_tile(self, tile: MediaTileConfig, browser_bin: str) -> None:
        """Launch a browser --app or native desktop client on Workspace 2."""

    def focus_workspace(self, workspace: Literal["1:hub", "2:media"]) -> None:
        """Switch Sway focus to Workspace 1 (Hub) or Workspace 2 (Media)."""

    def close_media_workspace(self) -> None:
        """Close any active window in Workspace 2."""

    def pause_mpris(self) -> None:
        """Pause active MPRIS media players."""


class MockCompositorBackend:
    """In-memory compositor backend for macOS development and tests."""

    def __init__(self) -> None:
        self.workspace: Literal["1:hub", "2:media"] = "1:hub"
        self.launched_tile: MediaTileConfig | None = None
        self.paused_count = 0
        self.closed_count = 0

    def launch_tile(self, tile: MediaTileConfig, browser_bin: str) -> None:
        self.launched_tile = tile
        self.workspace = "2:media"

    def focus_workspace(self, workspace: Literal["1:hub", "2:media"]) -> None:
        self.workspace = workspace

    def close_media_workspace(self) -> None:
        self.launched_tile = None
        self.closed_count += 1

    def pause_mpris(self) -> None:
        self.paused_count += 1


class SwayCompositorBackend:
    """Executes Sway IPC commands via swaymsg and launches Brave/Stremio."""

    def __init__(self) -> None:
        self._active_proc: subprocess.Popen[bytes] | None = None

    def _swaymsg(self, *args: str) -> None:
        try:
            subprocess.run(["swaymsg", *args], check=False, capture_output=True, timeout=2.0)
        except OSError as err:
            _LOGGER.warning("swaymsg failed: %s", err)

    def launch_tile(self, tile: MediaTileConfig, browser_bin: str) -> None:
        self.focus_workspace("2:media")
        if tile.kind == "browser_app":
            cmd = [
                browser_bin,
                f"--app={tile.target}",
                "--class=surface-media",
                "--ozone-platform=wayland",
                "--enable-features=VaapiVideoDecoder",
                "--start-fullscreen",
                "--no-first-run",
            ]
        else:
            cmd = [tile.target]

        try:
            self._active_proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            self._swaymsg('[workspace="2:media"]', "fullscreen", "enable")
        except OSError as err:
            _LOGGER.error("Failed launching tile %s: %s", tile.id, err)
            raise

    def focus_workspace(self, workspace: Literal["1:hub", "2:media"]) -> None:
        self._swaymsg("workspace", workspace)

    def close_media_workspace(self) -> None:
        self._swaymsg('[workspace="2:media"]', "kill")
        if self._active_proc is not None and self._active_proc.poll() is None:
            self._active_proc.terminate()
        self._active_proc = None

    def pause_mpris(self) -> None:
        try:
            subprocess.run(
                ["playerctl", "-a", "pause"],
                check=False,
                capture_output=True,
                timeout=2.0,
            )
        except OSError as err:
            _LOGGER.debug("playerctl pause unavailable: %s", err)


class MediaService:
    """Coordinates single-window video lifecycle and Sleep Timer automation."""

    def __init__(
        self,
        backend: CompositorBackend,
        tiles: list[MediaTileConfig],
        browser_bin: str,
        night_mode: AmbientNightModeController,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._backend = backend
        self._tiles = {t.id: t for t in tiles}
        self._browser_bin = browser_bin
        self._night_mode = night_mode
        self._clock = clock
        self._state = MediaState()
        self._sleep_deadline: float | None = None

    @property
    def state(self) -> MediaState:
        self._refresh_remaining()
        return self._state.model_copy()

    def _refresh_remaining(self) -> None:
        if self._sleep_deadline is None:
            self._state.sleep_timer_remaining_seconds = None
            return
        remaining = max(0, int(self._sleep_deadline - self._clock()))
        self._state.sleep_timer_remaining_seconds = remaining

    def launch_tile(self, tile_id: str) -> MediaState:
        tile = self._tiles.get(tile_id)
        if tile is None:
            raise KeyError(f"Unknown media tile: {tile_id}")

        # Single active video window policy: reuse same window if already open,
        # otherwise close previous video app before launching a new tile.
        if self._state.active_tile_id == tile_id:
            self._backend.focus_workspace("2:media")
        else:
            if self._state.active_tile_id is not None:
                self._backend.pause_mpris()
                self._backend.close_media_workspace()
            self._backend.launch_tile(tile, self._browser_bin)
            self._state.active_tile_id = tile_id

        self._state.active_workspace = "2:media"
        self._night_mode.set_video_active(True)
        return self.state

    def return_home(self) -> MediaState:
        self._backend.pause_mpris()
        self._backend.focus_workspace("1:hub")
        self._state.active_workspace = "1:hub"
        self._night_mode.set_video_active(False)
        return self.state

    def set_sleep_timer(self, minutes: int) -> MediaState:
        if minutes <= 0:
            self._sleep_deadline = None
            self._state.sleep_timer_remaining_seconds = None
        else:
            self._sleep_deadline = self._clock() + (minutes * 60)
            self._refresh_remaining()
        return self.state

    def expire_sleep_timer_now(self) -> bool:
        """Force sleep timer expiration immediately for Mac simulation and testing."""
        self._sleep_deadline = self._clock() - 1.0
        return self.tick_sleep_timer()

    def tick_sleep_timer(self) -> bool:
        """Check sleep timer expiry; returns True if timer expired and executed."""
        if self._sleep_deadline is None:
            return False
        if self._clock() < self._sleep_deadline:
            self._refresh_remaining()
            return False

        self._sleep_deadline = None
        self._state.sleep_timer_remaining_seconds = None
        self._backend.pause_mpris()
        self._backend.close_media_workspace()
        self._backend.focus_workspace("1:hub")
        self._state.active_tile_id = None
        self._state.active_workspace = "1:hub"
        self._night_mode.force_night_mode()
        return True
