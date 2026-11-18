"""Sway compositor IPC, single-window video launcher, MPRIS pause, and sleep timer."""

from __future__ import annotations

import inspect
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, Protocol

from daemon.ambient_light import AmbientNightModeController
from daemon.models import MediaState, MediaTileConfig

_LOGGER = logging.getLogger(__name__)


def _iter_workspace_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    workspaces: list[dict[str, Any]] = []
    if node.get("type") == "workspace":
        workspaces.append(node)
        return workspaces
    for child in node.get("nodes", []):
        if isinstance(child, dict):
            workspaces.extend(_iter_workspace_nodes(child))
    return workspaces


def _node_has_windows(node: dict[str, Any]) -> bool:
    node_type = node.get("type")
    children = [*node.get("nodes", []), *node.get("floating_nodes", [])]
    if node_type in ("con", "floating_con") and (
        node.get("pid") is not None
        or node.get("app_id") is not None
        or node.get("window") is not None
        or not children
    ):
        return True
    return any(isinstance(child, dict) and _node_has_windows(child) for child in children)


def _node_is_focused(node: dict[str, Any]) -> bool:
    if node.get("focused") is True:
        return True
    children = [*node.get("nodes", []), *node.get("floating_nodes", [])]
    return any(isinstance(child, dict) and _node_is_focused(child) for child in children)


class CompositorBackend(Protocol):
    """Abstraction over Sway Wayland IPC + MPRIS player control."""

    def is_active_alive(self) -> bool:
        """Return True if the currently launched media process is still alive."""

    def launch_tile(
        self,
        tile: MediaTileConfig,
        browser_bin: str,
        on_exit: Callable[[], None] | None = None,
    ) -> None:
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
        self.launch_count = 0
        self.paused_count = 0
        self.closed_count = 0
        self._active_alive = False
        self._on_exit: Callable[[], None] | None = None

    def is_active_alive(self) -> bool:
        return self._active_alive

    def launch_tile(
        self,
        tile: MediaTileConfig,
        browser_bin: str,
        on_exit: Callable[[], None] | None = None,
    ) -> None:
        self.launched_tile = tile
        self.launch_count += 1
        self.workspace = "2:media"
        self._active_alive = True
        self._on_exit = on_exit

    def focus_workspace(self, workspace: Literal["1:hub", "2:media"]) -> None:
        self.workspace = workspace

    def close_media_workspace(self) -> None:
        self._active_alive = False
        self._on_exit = None
        self.launched_tile = None
        self.closed_count += 1

    def pause_mpris(self) -> None:
        self.paused_count += 1

    def workspace_has_windows(self, workspace: str) -> bool | None:
        """Return True when the simulated media workspace has an active window."""
        return workspace == "2:media" and self._active_alive

    def focused_workspace(self) -> str | None:
        """Return the currently focused simulated workspace."""
        return self.workspace


class SwayCompositorBackend:
    """Executes Sway IPC commands via swaymsg and launches Brave/Stremio."""

    def __init__(
        self,
        runtime_dir: Path | None = None,
        x11_unix_dir: Path = Path("/tmp/.X11-unix"),
    ) -> None:
        self._runtime_dir = runtime_dir
        self._x11_unix_dir = x11_unix_dir
        self._active_proc: subprocess.Popen[bytes] | None = None
        self._active_tile_id: str | None = None
        self._launch_started_at: float | None = None

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
        runtime_dir = self._resolve_runtime_dir()
        existing = os.environ.get("WAYLAND_DISPLAY", "").strip()
        if existing:
            candidate = Path(existing) if Path(existing).is_absolute() else runtime_dir / existing
            if candidate.exists():
                return existing
        sock = self._newest_matching_file(
            runtime_dir,
            "wayland-[0-9]*",
            predicate=lambda p: not p.name.endswith(".lock")
            and p.name.removeprefix("wayland-").isdigit(),
        )
        return sock.name if sock is not None else None

    def _resolve_display(self) -> str | None:
        """Resolve X11/XWayland DISPLAY from env or /tmp/.X11-unix sockets."""
        existing = os.environ.get("DISPLAY", "").strip()
        if existing:
            display_num = existing.lstrip(":").split(".", 1)[0]
            if display_num.isdigit() and (self._x11_unix_dir / f"X{display_num}").exists():
                return existing
        sock = self._newest_matching_file(
            self._x11_unix_dir,
            "X[0-9]*",
            predicate=lambda p: p.name.removeprefix("X").isdigit(),
        )
        return f":{sock.name.removeprefix('X')}" if sock is not None else None

    @staticmethod
    def _resolve_xdg_data_dirs(existing: str) -> str:
        """Ensure Flatpak export paths are present in XDG_DATA_DIRS."""
        raw = existing.strip()
        parts = (
            [entry for entry in raw.split(":") if entry]
            if raw
            else ["/usr/local/share", "/usr/share"]
        )
        normalized = {entry.rstrip("/") or "/" for entry in parts}
        flatpak_dirs = (
            "/var/lib/flatpak/exports/share",
            f"{Path.home()}/.local/share/flatpak/exports/share",
        )
        for flatpak_dir in flatpak_dirs:
            norm = flatpak_dir.rstrip("/") or "/"
            if norm not in normalized:
                parts.append(flatpak_dir)
                normalized.add(norm)
        return ":".join(parts)

    def _build_env(self) -> dict[str, str]:
        """Build subprocess environment with resolved Sway, Wayland, X11, and DBus variables."""
        env = os.environ.copy()
        swaysock = self._resolve_swaysock()
        if swaysock is not None:
            env["SWAYSOCK"] = swaysock
        wayland_display = self._resolve_wayland_display()
        if wayland_display is not None:
            env["WAYLAND_DISPLAY"] = wayland_display
        display = self._resolve_display()
        if display is not None:
            env["DISPLAY"] = display
        if not env.get("DBUS_SESSION_BUS_ADDRESS", "").strip():
            bus_socket = self._resolve_runtime_dir() / "bus"
            if bus_socket.exists():
                env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus_socket}"
        if not env.get("XDG_CURRENT_DESKTOP", "").strip():
            env["XDG_CURRENT_DESKTOP"] = "sway"
        if not env.get("XDG_SESSION_TYPE", "").strip():
            env["XDG_SESSION_TYPE"] = "wayland"
        env["XDG_DATA_DIRS"] = self._resolve_xdg_data_dirs(env.get("XDG_DATA_DIRS", ""))
        return env

    @staticmethod
    def _read_json_dict(path: Path) -> dict[str, Any]:
        """Read a JSON object from path, returning an empty dict if missing or invalid."""
        if not path.exists():
            return {}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            _LOGGER.warning("Resetting invalid JSON profile file %s: %s", path, err)
            return {}
        if not isinstance(loaded, dict):
            _LOGGER.warning("Resetting non-object JSON profile file %s", path)
            return {}
        return loaded

    @staticmethod
    def _write_json_dict(path: Path, data: dict[str, Any]) -> None:
        """Write JSON object cleanly to path."""
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _prepare_media_profile(self, media_profile_dir: Path) -> None:
        """Prepare isolated Brave media profile without crash bubbles, popups, or stale locks."""
        default_dir = media_profile_dir / "Default"
        default_dir.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(default_dir / "Sessions", ignore_errors=True)

        for lock_name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
            lock_path = media_profile_dir / lock_name
            try:
                lock_path.unlink(missing_ok=True)
            except OSError as err:
                _LOGGER.warning("Failed removing stale lock %s: %s", lock_path, err)

        prefs_path = default_dir / "Preferences"
        prefs = self._read_json_dict(prefs_path)
        profile = prefs.get("profile")
        if not isinstance(profile, dict):
            profile = {}
            prefs["profile"] = profile
        profile["exit_type"] = "Normal"
        profile["exited_cleanly"] = True
        content_settings = profile.get("default_content_setting_values")
        if not isinstance(content_settings, dict):
            content_settings = {}
            profile["default_content_setting_values"] = content_settings
        content_settings["popups"] = 2
        self._write_json_dict(prefs_path, prefs)

        local_state_path = media_profile_dir / "Local State"
        local_state = self._read_json_dict(local_state_path)
        brave = local_state.get("brave")
        if not isinstance(brave, dict):
            brave = {}
            local_state["brave"] = brave
        brave["widevine_opted_in"] = True
        self._write_json_dict(local_state_path, local_state)

    def _swaymsg(self, *args: str) -> None:
        try:
            subprocess.run(
                ["swaymsg", *args],
                check=False,
                capture_output=True,
                timeout=2.0,
                env=self._build_env(),
            )
        except (OSError, subprocess.SubprocessError) as err:
            _LOGGER.warning("swaymsg failed: %s", err)

    def _get_tree(self) -> dict[str, Any] | None:
        """Fetch and parse Sway IPC layout tree, or return None if unavailable."""
        try:
            res = subprocess.run(
                ["swaymsg", "-t", "get_tree", "-r"],
                check=False,
                capture_output=True,
                timeout=2.0,
                env=self._build_env(),
            )
        except (OSError, subprocess.SubprocessError) as err:
            _LOGGER.debug("swaymsg get_tree unavailable: %s", err)
            return None
        if res.returncode != 0:
            return None
        raw_stdout: object = res.stdout
        if isinstance(raw_stdout, bytes):
            raw_text = raw_stdout.decode("utf-8", errors="replace")
        elif isinstance(raw_stdout, str):
            raw_text = raw_stdout
        else:
            return None
        if not raw_text.strip():
            return None
        try:
            parsed = json.loads(raw_text)
        except json.JSONDecodeError as err:
            _LOGGER.debug("Invalid JSON from swaymsg get_tree: %s", err)
            return None
        return parsed if isinstance(parsed, dict) else None

    def workspace_has_windows(self, workspace: str) -> bool | None:
        """Return True if workspace has windows, False if empty, or None if unavailable."""
        tree = self._get_tree()
        if tree is None:
            return None
        for ws in _iter_workspace_nodes(tree):
            if ws.get("name") == workspace:
                return _node_has_windows(ws)
        return False

    def focused_workspace(self) -> str | None:
        """Return the currently focused Sway workspace name, or None if unavailable."""
        tree = self._get_tree()
        if tree is None:
            return None
        for ws in _iter_workspace_nodes(tree):
            name = ws.get("name")
            if name == "__i3_scratch" or not isinstance(name, str):
                continue
            if _node_is_focused(ws):
                return name
        return None

    def is_active_alive(self) -> bool:
        if self._active_proc is None or self._active_proc.poll() is not None:
            return False
        if (
            self._launch_started_at is not None
            and (time.monotonic() - self._launch_started_at) > 5.0
            and self.workspace_has_windows("2:media") is False
        ):
            self.close_media_workspace()
            return False
        return True

    def launch_tile(
        self,
        tile: MediaTileConfig,
        browser_bin: str,
        on_exit: Callable[[], None] | None = None,
    ) -> None:
        target = tile.target.strip()
        if not target:
            raise ValueError(f"Empty target for media tile '{tile.id}'")

        if self._active_proc is not None or self.workspace_has_windows("2:media") is True:
            self.close_media_workspace()

        if tile.kind == "browser_app":
            media_profile_dir = Path.home() / ".local/share/surface-assistant/media-profile"
            self._prepare_media_profile(media_profile_dir)
            cmd = [
                browser_bin,
                f"--user-data-dir={media_profile_dir}",
                "--kiosk",
                target,
                "--class=surface-media",
                "--ozone-platform=wayland",
                "--touch-events=enabled",
                "--password-store=basic",
                "--disable-features=Vulkan",
                "--enable-features=VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks",
                "--overscroll-history-navigation=0",
                "--disable-pinch",
                "--no-first-run",
                "--noerrdialogs",
                "--disable-session-crashed-bubble",
            ]
        else:
            cmd = [target]

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env=self._build_env(),
            )
        except OSError as err:
            _LOGGER.error("Failed launching tile %s: %s", tile.id, err)
            raise

        rc = proc.poll()
        if rc is not None and rc != 0:
            raise RuntimeError(f"Media tile '{tile.id}' exited immediately with code {rc}")

        self._active_proc = proc
        self._active_tile_id = tile.id
        self._launch_started_at = time.monotonic()
        self.focus_workspace("2:media")

        def _watch_proc() -> None:
            wait_fn = getattr(proc, "wait", None)
            if not callable(wait_fn):
                return
            try:
                wait_fn()
            except Exception as err:
                _LOGGER.debug("Watcher stopped for tile %s: %s", tile.id, err)
                return
            if self._active_proc is proc:
                self._active_proc = None
                self._active_tile_id = None
                self._launch_started_at = None
                if on_exit is not None:
                    on_exit()
                self.focus_workspace("1:hub")

        threading.Thread(target=_watch_proc, daemon=True).start()

    def focus_workspace(self, workspace: Literal["1:hub", "2:media"]) -> None:
        self._swaymsg("workspace", workspace)

    @staticmethod
    def _signal_proc_group(proc: subprocess.Popen[bytes], sig: signal.Signals) -> None:
        """Send signal to the child's process group, falling back to proc.terminate/kill."""
        pid = getattr(proc, "pid", None)
        if isinstance(pid, int) and pid > 0:
            try:
                os.killpg(pid, sig)
                return
            except ProcessLookupError:
                if proc.poll() is not None:
                    return
            except OSError:
                pass
        method = getattr(proc, "kill" if sig == signal.SIGKILL else "terminate", None)
        if callable(method):
            try:
                method()
            except ProcessLookupError:
                return

    @staticmethod
    def _wait_proc(proc: subprocess.Popen[bytes], timeout: float) -> None:
        """Wait up to timeout for proc exit, tolerating fake procs without timeout arg."""
        wait_fn = getattr(proc, "wait", None)
        if not callable(wait_fn):
            return
        accepts_timeout = False
        try:
            sig = inspect.signature(wait_fn)
            accepts_timeout = "timeout" in sig.parameters or any(
                param.kind == inspect.Parameter.VAR_KEYWORD
                for param in sig.parameters.values()
            )
        except (ValueError, TypeError):
            accepts_timeout = True
        try:
            if accepts_timeout:
                wait_fn(timeout=timeout)
            else:
                wait_fn()
        except TypeError:
            try:
                wait_fn()
            except subprocess.TimeoutExpired:
                return
        except subprocess.TimeoutExpired:
            return

    def close_media_workspace(self) -> None:
        proc = self._active_proc
        tile_id = self._active_tile_id
        self._active_proc = None
        self._active_tile_id = None
        self._launch_started_at = None
        self._swaymsg('[workspace="2:media"]', "kill")
        if proc is not None and proc.poll() is None:
            self._signal_proc_group(proc, signal.SIGTERM)
            self._wait_proc(proc, 2.0)
            if proc.poll() is None:
                self._signal_proc_group(proc, signal.SIGKILL)
                self._wait_proc(proc, 0.5)
        if (
            sys.platform.startswith("linux")
            and tile_id in ("stremio", None)
            and shutil.which("flatpak") is not None
        ):
            try:
                subprocess.run(
                    ["flatpak", "kill", "com.stremio.Stremio"],
                    check=False,
                    capture_output=True,
                    timeout=2.0,
                    env=self._build_env(),
                )
            except (OSError, subprocess.SubprocessError) as err:
                _LOGGER.debug("flatpak kill com.stremio.Stremio failed: %s", err)

    def pause_mpris(self) -> None:
        try:
            subprocess.run(
                ["playerctl", "-a", "pause"],
                check=False,
                capture_output=True,
                timeout=2.0,
                env=self._build_env(),
            )
        except (OSError, subprocess.SubprocessError) as err:
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
        on_state_change: Callable[[], None] | None = None,
    ) -> None:
        self._backend = backend
        self._tiles = {t.id: t for t in tiles}
        self._browser_bin = browser_bin
        self._night_mode = night_mode
        self._clock = clock
        self._state = MediaState()
        self._sleep_deadline: float | None = None
        self._on_state_change = on_state_change

    def set_on_state_change(self, callback: Callable[[], None] | None) -> None:
        """Register callback invoked when media state changes asynchronously."""
        self._on_state_change = callback

    def _notify_state_change(self) -> None:
        if self._on_state_change is None:
            return
        try:
            self._on_state_change()
        except Exception:
            _LOGGER.exception("Media state change callback failed")

    def _clear_inactive_session(self) -> None:
        self._state.active_tile_id = None
        self._state.active_workspace = "1:hub"
        self._night_mode.set_video_active(False)

    @property
    def state(self) -> MediaState:
        if self._state.active_tile_id is not None and not self._backend.is_active_alive():
            self._clear_inactive_session()
        self._refresh_remaining()
        return self._state.model_copy()

    def get_state(self) -> MediaState:
        return self.state

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

        # Single active video window policy: reuse same window if already open and alive,
        # otherwise close previous video app before launching a new tile.
        if self._state.active_tile_id == tile_id and self._backend.is_active_alive():
            self._backend.focus_workspace("2:media")
            self._state.active_workspace = "2:media"
            self._night_mode.set_video_active(True)
        else:
            if self._state.active_tile_id is not None:
                self._backend.pause_mpris()
                self._backend.close_media_workspace()

            def _on_exit() -> None:
                if self._state.active_tile_id in (tile_id, None):
                    self._clear_inactive_session()
                    self._notify_state_change()

            self._state.active_tile_id = tile_id
            self._state.active_workspace = "2:media"
            self._night_mode.set_video_active(True)
            try:
                self._backend.launch_tile(tile, self._browser_bin, on_exit=_on_exit)
            except Exception:
                self._clear_inactive_session()
                raise

        return self.state

    def return_home(self) -> MediaState:
        self._backend.pause_mpris()
        self._backend.focus_workspace("1:hub")
        self._state.active_workspace = "1:hub"
        self._night_mode.set_video_active(False)
        return self.state

    def close_media(self) -> MediaState:
        """Close the active media session, return to Hub, and clear active tile state."""
        self._backend.pause_mpris()
        self._backend.close_media_workspace()
        self._backend.focus_workspace("1:hub")
        self._clear_inactive_session()
        return self.state

    def reconcile_external_exit(self) -> bool:
        """Clear inactive media session if the active process exited externally."""
        if self._state.active_tile_id is not None and not self._backend.is_active_alive():
            if self._state.active_workspace == "2:media":
                self._backend.focus_workspace("1:hub")
            self._clear_inactive_session()
            return True
        return False

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
