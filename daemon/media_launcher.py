"""Sway compositor IPC, single-window video launcher, MPRIS pause, and sleep timer."""

from __future__ import annotations

import logging
import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
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

    def __init__(self, runtime_dir: Path | None = None) -> None:
        self._runtime_dir = runtime_dir
        self._active_proc: subprocess.Popen[bytes] | None = None

    def _resolve_runtime_dir(self) -> Path:
        """Return the runtime directory where Sway and Wayland sockets reside."""
        if self._runtime_dir is not None:
            return self._runtime_dir
        xdg_runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip()
        if xdg_runtime:
            return Path(xdg_runtime)
        return Path(f"/run/user/{os.getuid()}")

    @staticmethod
    def _newest_matching_file(
        directory: Path,
        pattern: str,
        predicate: Callable[[Path], bool] | None = None,
    ) -> Path | None:
        """Return the newest non-directory file matching pattern in directory."""
        if not directory.is_dir():
            return None
        candidates: list[tuple[float, str, Path]] = []
        for candidate in directory.glob(pattern):
            if not candidate.exists() or candidate.is_dir():
                continue
            if predicate is not None and not predicate(candidate):
                continue
            try:
                mtime = candidate.stat().st_mtime
            except OSError:
                continue
            candidates.append((mtime, candidate.name, candidate))
        if not candidates:
            return None
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return candidates[0][2]

    def _resolve_swaysock(self) -> str | None:
        """Resolve an existing SWAYSOCK path from env or runtime_dir."""
        existing = os.environ.get("SWAYSOCK", "").strip()
        if existing and Path(existing).exists():
            return existing
        sock = self._newest_matching_file(self._resolve_runtime_dir(), "sway-ipc.*.sock")
        return str(sock) if sock is not None else None

    def _resolve_wayland_display(self) -> str | None:
        """Resolve WAYLAND_DISPLAY from env or active Wayland sockets in runtime_dir."""
        existing = os.environ.get("WAYLAND_DISPLAY", "").strip()
        if existing:
            return existing
        sock = self._newest_matching_file(
            self._resolve_runtime_dir(),
            "wayland-[0-9]*",
            predicate=lambda p: not p.name.endswith(".lock")
            and p.name.removeprefix("wayland-").isdigit(),
        )
        return sock.name if sock is not None else None

    def _build_env(self) -> dict[str, str]:
        """Build subprocess environment with resolved Sway and Wayland IPC variables."""
        env = os.environ.copy()
        swaysock = self._resolve_swaysock()
        if swaysock is not None:
            env["SWAYSOCK"] = swaysock
        wayland_display = self._resolve_wayland_display()
        if wayland_display is not None:
            env["WAYLAND_DISPLAY"] = wayland_display
        return env

    def _swaymsg(self, *args: str) -> None:
        try:
            subprocess.run(
                ["swaymsg", *args],
                check=False,
                capture_output=True,
                timeout=2.0,
                env=self._build_env(),
            )
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
                "--touch-events=enabled",
                "--password-store=basic",
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
                env=self._build_env(),
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
