"""Tests for media launcher, sleep timer, wallpapers, and knowledge service."""

from __future__ import annotations

import json
import os
import random
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from daemon.ambient_light import AmbientNightModeController, MockAmbientBackend
from daemon.config import EnvSettings, NightModeConfig, load_config
from daemon.knowledge import KnowledgeService
from daemon.media_launcher import (
    MediaService,
    MockCompositorBackend,
    SwayCompositorBackend,
)
from daemon.models import MediaTileConfig
from daemon.wallpapers import WallpaperService


class FakeClock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_single_window_policy_and_sleep_timer_expiry() -> None:
    clock = FakeClock()
    comp = MockCompositorBackend()
    night = AmbientNightModeController(MockAmbientBackend(), NightModeConfig(), clock=clock)
    tiles = [
        MediaTileConfig(id="youtube", label="YouTube", kind="browser_app", target="https://youtube.com"),
        MediaTileConfig(id="netflix", label="Netflix", kind="browser_app", target="https://netflix.com"),
    ]
    svc = MediaService(comp, tiles, "brave-browser", night, clock=clock)

    svc.launch_tile("youtube")
    assert comp.workspace == "2:media"
    assert comp.launched_tile is not None and comp.launched_tile.id == "youtube"

    # Switching to Netflix closes the previous window cleanly
    svc.launch_tile("netflix")
    assert comp.closed_count == 1
    assert comp.launched_tile is not None and comp.launched_tile.id == "netflix"

    # Returning Home pauses MPRIS and keeps tile available for resume
    svc.return_home()
    assert svc.state.active_workspace == "1:hub"
    assert comp.paused_count >= 2
    assert svc.state.active_tile_id == "netflix"

    # Sleep timer expiry closes media, returns Home, and forces Night Mode
    svc.launch_tile("netflix")
    svc.set_sleep_timer(15)
    clock.advance(15 * 60 + 1)
    assert svc.tick_sleep_timer() is True
    assert svc.state.active_workspace == "1:hub"
    assert svc.state.active_tile_id is None
    assert night.state.enabled is True


def test_wallpaper_service_loads_local_and_prevents_traversal(tmp_path: Path) -> None:
    static_dir = tmp_path / "static"
    loops_dir = tmp_path / "loops"
    static_dir.mkdir()
    loops_dir.mkdir()
    (static_dir / "art.png").write_bytes(b"png")
    (loops_dir / "rain.mp4").write_bytes(b"mp4")
    (static_dir / "ignored.txt").write_text("nope", encoding="utf-8")

    svc = WallpaperService(tmp_path, interval_seconds=180)
    assert len(svc.state.items) == 2
    assert svc.state.items[0].kind == "image"
    assert svc.state.items[1].kind == "video"
    assert svc.resolve_file("../../etc/passwd") is None

    svc.next_wallpaper()
    assert svc.state.current_index == 1
    svc.next_wallpaper()
    assert svc.state.current_index == 0


def test_wallpaper_service_falls_back_to_bundled_assets(tmp_path: Path) -> None:
    svc = WallpaperService(tmp_path / "empty_dir")
    assert len(svc.state.items) >= 2
    first = svc.state.items[0]
    resolved = svc.resolve_file(first.id)
    assert resolved is not None and resolved.exists()


def test_wallpaper_service_shuffle_mixes_and_avoids_repeat_on_wrap(tmp_path: Path) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    names = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"]
    for name in names:
        (static_dir / name).write_bytes(b"img")

    svc = WallpaperService(tmp_path, shuffle=True, rng=random.Random(7))
    first_cycle = [item.filename for item in svc.state.items]
    assert sorted(first_cycle) == names
    assert first_cycle != names

    for idx in range(len(names) - 1):
        state = svc.next_wallpaper()
        assert state.current_index == idx + 1

    last_item_id = svc.state.items[-1].id
    wrapped = svc.next_wallpaper()
    assert wrapped.current_index == 0
    assert wrapped.items[0].id != last_item_id
    assert sorted(item.filename for item in wrapped.items) == names
    for item in wrapped.items:
        resolved = svc.resolve_file(item.id)
        assert resolved is not None and resolved.exists()


@pytest.mark.asyncio
async def test_knowledge_service_weather_and_wikipedia_fallback() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "api.open-meteo.com" in str(request.url):
            return httpx.Response(
                200,
                json={"current": {"temperature_2m": 28.4, "weather_code": 1}},
            )
        if "action=opensearch" in str(request.url):
            return httpx.Response(200, json=["query", ["Hyderabad"]])
        if "rest_v1/page/summary" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "extract": (
                        "Hyderabad is the capital of Telangana. "
                        "It is a major tech hub. Third sentence omitted."
                    )
                },
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        svc = KnowledgeService(17.3850, 78.4867, client=client)
        weather = await svc.fetch_weather()
        assert weather is not None
        assert weather.temperature_c == 28.4
        assert weather.condition_label == "Mainly Clear"

        ans = await svc.answer_query("Tell me about Hyderabad")
        assert ans.source == "wikipedia"
        assert ans.answer == "Hyderabad is the capital of Telangana. It is a major tech hub."


def test_sway_backend_discovers_sockets_from_runtime_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SWAYSOCK", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.delenv("DISPLAY", raising=False)

    old_sock = tmp_path / "sway-ipc.1000.100.sock"
    new_sock = tmp_path / "sway-ipc.1000.200.sock"
    old_sock.touch()
    new_sock.touch()
    os.utime(old_sock, (1000, 1000))
    os.utime(new_sock, (2000, 2000))

    wayland_sock = tmp_path / "wayland-1"
    wayland_lock = tmp_path / "wayland-1.lock"
    wayland_sock.touch()
    wayland_lock.touch()
    os.utime(wayland_sock, (1000, 1000))
    os.utime(wayland_lock, (3000, 3000))

    x11_dir = tmp_path / "x11"
    x11_dir.mkdir()
    (x11_dir / "X0").touch()

    backend = SwayCompositorBackend(runtime_dir=tmp_path, x11_unix_dir=x11_dir)
    env = backend._build_env()

    assert env["SWAYSOCK"] == str(new_sock)
    assert env["WAYLAND_DISPLAY"] == "wayland-1"
    assert env["DISPLAY"] == ":0"

    # Stale/non-existent SWAYSOCK falls back to discovered socket
    monkeypatch.setenv("SWAYSOCK", str(tmp_path / "missing.sock"))
    assert backend._build_env()["SWAYSOCK"] == str(new_sock)


def test_sway_backend_respects_existing_env_vars(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    (runtime_dir / "sway-ipc.1000.999.sock").touch()
    (runtime_dir / "wayland-0").touch()
    (runtime_dir / "wayland-1").touch()

    custom_sock = tmp_path / "custom-sway.sock"
    custom_sock.touch()
    monkeypatch.setenv("SWAYSOCK", str(custom_sock))
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-0")

    backend = SwayCompositorBackend(runtime_dir=runtime_dir)
    env = backend._build_env()

    assert env["SWAYSOCK"] == str(custom_sock)
    assert env["WAYLAND_DISPLAY"] == "wayland-0"

    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-99")
    assert backend._build_env()["WAYLAND_DISPLAY"] == "wayland-1"


def test_sway_backend_passes_resolved_env_to_subprocess(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SWAYSOCK", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)

    sway_sock = tmp_path / "sway-ipc.1000.42.sock"
    sway_sock.touch()
    (tmp_path / "wayland-1").touch()

    run_calls: list[tuple[list[str], dict[str, str]]] = []
    popen_calls: list[tuple[list[str], dict[str, str]]] = []
    events: list[str] = []
    terminated_procs: list[FakeProc] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        run_calls.append((cmd, kwargs["env"]))
        events.append(f"run:{' '.join(cmd)}")
        return subprocess.CompletedProcess(cmd, 0)

    class FakeProc:
        def poll(self) -> int | None:
            return None

        def terminate(self) -> None:
            terminated_procs.append(self)

    def fake_popen(cmd: list[str], **kwargs: Any) -> FakeProc:
        popen_calls.append((cmd, kwargs["env"]))
        events.append(f"popen:{cmd[0]}")
        return FakeProc()

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    backend.launch_tile(
        MediaTileConfig(
            id="youtube",
            label="YouTube",
            kind="browser_app",
            target="https://youtube.com",
        ),
        "brave-browser",
    )
    backend.launch_tile(
        MediaTileConfig(
            id="stremio",
            label="Stremio",
            kind="native_app",
            target="stremio",
        ),
        "brave-browser",
    )

    assert len(run_calls) == 4
    assert run_calls[0][0] == ["swaymsg", "-t", "get_tree", "-r"]
    assert run_calls[1][0] == ["swaymsg", "workspace", "2:media"]
    assert run_calls[2][0] == ["swaymsg", '[workspace="2:media"]', "kill"]
    assert run_calls[3][0] == ["swaymsg", "workspace", "2:media"]
    assert ["swaymsg", '[workspace="2:media"]', "fullscreen", "enable"] not in [
        cmd for cmd, _ in run_calls
    ]
    assert events == [
        "run:swaymsg -t get_tree -r",
        "popen:brave-browser",
        "run:swaymsg workspace 2:media",
        'run:swaymsg [workspace="2:media"] kill',
        "popen:stremio",
        "run:swaymsg workspace 2:media",
    ]
    assert len(terminated_procs) == 1
    for _, env in run_calls:
        assert env["SWAYSOCK"] == str(sway_sock)
        assert env["WAYLAND_DISPLAY"] == "wayland-1"

    assert len(popen_calls) == 2
    brave_cmd = popen_calls[0][0]
    assert brave_cmd[0] == "brave-browser"
    expected_profile = tmp_path / ".local/share/surface-assistant/media-profile"
    assert f"--user-data-dir={expected_profile}" in brave_cmd
    assert "--kiosk" in brave_cmd
    assert "https://youtube.com" in brave_cmd
    assert "--app=https://youtube.com" not in brave_cmd
    assert "--start-fullscreen" not in brave_cmd
    for expected_flag in (
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
    ):
        assert expected_flag in brave_cmd
    assert (expected_profile / "Default" / "Preferences").exists()
    assert (expected_profile / "Local State").exists()
    assert popen_calls[0][1]["SWAYSOCK"] == str(sway_sock)
    assert popen_calls[0][1]["WAYLAND_DISPLAY"] == "wayland-1"

    assert popen_calls[1][0] == ["stremio"]
    assert popen_calls[1][1]["SWAYSOCK"] == str(sway_sock)
    assert popen_calls[1][1]["WAYLAND_DISPLAY"] == "wayland-1"


def test_launch_tile_relaunches_when_active_process_exited() -> None:
    clock = FakeClock()
    comp = MockCompositorBackend()
    night = AmbientNightModeController(MockAmbientBackend(), NightModeConfig(), clock=clock)
    tiles = [
        MediaTileConfig(
            id="youtube",
            label="YouTube",
            kind="browser_app",
            target="https://youtube.com",
        ),
    ]
    svc = MediaService(comp, tiles, "brave-browser", night, clock=clock)

    svc.launch_tile("youtube")
    assert comp.launch_count == 1
    assert svc.state.active_tile_id == "youtube"

    # Launching same tile while process is alive only focuses 2:media without relaunching
    comp.focus_workspace("1:hub")
    svc.launch_tile("youtube")
    assert comp.launch_count == 1
    assert comp.workspace == "2:media"

    # If the process exits while active_tile_id is still set, launch_tile must relaunch
    comp._active_alive = False
    svc.launch_tile("youtube")
    assert comp.launch_count == 2
    assert comp.is_active_alive() is True
    assert svc.state.active_tile_id == "youtube"

    # And state/get_state() clears active_tile_id, active_workspace, and paused_for_video
    # if process is no longer alive
    comp._active_alive = False
    state_after_exit = svc.get_state()
    assert state_after_exit.active_tile_id is None
    assert state_after_exit.active_workspace == "1:hub"
    assert night.state.paused_for_video is False


def test_sway_backend_unexpected_exit_focuses_hub_and_clears_active_tile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "sway-ipc.1000.42.sock").touch()
    (tmp_path / "wayland-1").touch()

    run_calls: list[list[str]] = []
    exit_event = threading.Event()
    callback_done = threading.Event()

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        run_calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    class ControllableProc:
        def __init__(self) -> None:
            self.returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def wait(self) -> int:
            exit_event.wait(timeout=2.0)
            self.returncode = 1
            return 1

        def terminate(self) -> None:
            self.returncode = -15
            exit_event.set()

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: ControllableProc())
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    clock = FakeClock()
    night = AmbientNightModeController(MockAmbientBackend(), NightModeConfig(), clock=clock)
    tiles = [
        MediaTileConfig(
            id="youtube",
            label="YouTube",
            kind="browser_app",
            target="https://youtube.com",
        ),
    ]
    svc = MediaService(backend, tiles, "brave-browser", night, clock=clock)

    svc.launch_tile("youtube")
    assert backend.is_active_alive() is True
    assert svc.state.active_tile_id == "youtube"

    orig_focus = backend.focus_workspace

    def tracking_focus(workspace: Any) -> None:
        orig_focus(workspace)
        if workspace == "1:hub":
            callback_done.set()

    monkeypatch.setattr(backend, "focus_workspace", tracking_focus)

    # Simulate unexpected process exit
    exit_event.set()
    assert callback_done.wait(timeout=2.0) is True
    for _ in range(20):
        if svc._state.active_tile_id is None:
            break
        threading.Event().wait(0.01)

    assert backend.is_active_alive() is False
    assert ["swaymsg", "workspace", "1:hub"] in run_calls
    assert svc.state.active_tile_id is None
    assert svc.state.active_workspace == "1:hub"
    assert night.state.paused_for_video is False


def test_sway_backend_resolves_dbus_desktop_and_flatpak_xdg_data_dirs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DBUS_SESSION_BUS_ADDRESS", raising=False)
    monkeypatch.delenv("XDG_CURRENT_DESKTOP", raising=False)
    monkeypatch.delenv("XDG_SESSION_TYPE", raising=False)
    monkeypatch.delenv("XDG_DATA_DIRS", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    (tmp_path / "bus").touch()
    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    env = backend._build_env()

    assert env["DBUS_SESSION_BUS_ADDRESS"] == f"unix:path={tmp_path / 'bus'}"
    assert env["XDG_CURRENT_DESKTOP"] == "sway"
    assert env["XDG_SESSION_TYPE"] == "wayland"
    assert env["XDG_DATA_DIRS"] == (
        "/usr/local/share:/usr/share:/var/lib/flatpak/exports/share:"
        f"{tmp_path}/.local/share/flatpak/exports/share"
    )

    # Preserves explicit overrides and avoids duplicating existing Flatpak share entries
    monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/custom/bus")
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "custom-wm")
    monkeypatch.setenv("XDG_SESSION_TYPE", "x11")
    monkeypatch.setenv("XDG_DATA_DIRS", "/opt/share:/var/lib/flatpak/exports/share")
    overridden = backend._build_env()
    assert overridden["DBUS_SESSION_BUS_ADDRESS"] == "unix:path=/custom/bus"
    assert overridden["XDG_CURRENT_DESKTOP"] == "custom-wm"
    assert overridden["XDG_SESSION_TYPE"] == "x11"
    assert overridden["XDG_DATA_DIRS"] == (
        f"/opt/share:/var/lib/flatpak/exports/share:{tmp_path}/.local/share/flatpak/exports/share"
    )


def test_sway_backend_prepare_media_profile_cleans_locks_and_patches_json(
    tmp_path: Path,
) -> None:
    profile_dir = tmp_path / "media-profile"
    default_dir = profile_dir / "Default"
    sessions_dir = default_dir / "Sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "Session_1").write_text("stale", encoding="utf-8")

    # Include a dangling symlink for SingletonLock, as Chromium creates in real profiles
    (profile_dir / "SingletonLock").symlink_to("surface-99999")
    (profile_dir / "SingletonCookie").write_text("cookie", encoding="utf-8")
    (profile_dir / "SingletonSocket").write_text("sock", encoding="utf-8")

    (default_dir / "Preferences").write_text(
        json.dumps(
            {
                "profile": {
                    "exit_type": "Crashed",
                    "exited_cleanly": False,
                    "default_content_setting_values": {"cookies": 1},
                },
                "browser": {"window_placement": {"maximized": True}},
            }
        ),
        encoding="utf-8",
    )
    (profile_dir / "Local State").write_text(
        json.dumps({"os_crypt": {"encrypted_key": "abc"}}),
        encoding="utf-8",
    )

    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    backend._prepare_media_profile(profile_dir)

    assert not sessions_dir.exists()
    for lock_name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        lock_path = profile_dir / lock_name
        assert not lock_path.exists()
        assert not lock_path.is_symlink()

    prefs = json.loads((default_dir / "Preferences").read_text(encoding="utf-8"))
    assert prefs["profile"]["exit_type"] == "Normal"
    assert prefs["profile"]["exited_cleanly"] is True
    assert prefs["profile"]["default_content_setting_values"] == {"cookies": 1, "popups": 2}
    assert prefs["browser"] == {"window_placement": {"maximized": True}}

    local_state = json.loads((profile_dir / "Local State").read_text(encoding="utf-8"))
    assert local_state["brave"]["widevine_opted_in"] is True
    assert local_state["os_crypt"] == {"encrypted_key": "abc"}

    # Corrupt JSON files recover cleanly
    (default_dir / "Preferences").write_text("{corrupt", encoding="utf-8")
    (profile_dir / "Local State").write_text("[]", encoding="utf-8")
    backend._prepare_media_profile(profile_dir)

    repaired_prefs = json.loads((default_dir / "Preferences").read_text(encoding="utf-8"))
    assert repaired_prefs["profile"]["exit_type"] == "Normal"
    assert repaired_prefs["profile"]["exited_cleanly"] is True
    assert repaired_prefs["profile"]["default_content_setting_values"]["popups"] == 2
    repaired_local = json.loads((profile_dir / "Local State").read_text(encoding="utf-8"))
    assert repaired_local == {"brave": {"widevine_opted_in": True}}


def test_sway_backend_launch_failures_keep_hub_focus(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_calls: list[list[str]] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        run_calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    backend = SwayCompositorBackend(runtime_dir=tmp_path)

    # Empty target raises ValueError before Popen or workspace focus
    with pytest.raises(ValueError, match="Empty target"):
        backend.launch_tile(
            MediaTileConfig(id="anime", label="Anime", kind="browser_app", target="   "),
            "brave-browser",
        )
    assert run_calls == []
    assert backend.is_active_alive() is False

    # OSError from Popen keeps focus on 1:hub (never focuses 2:media)
    def fail_popen(*args: Any, **kwargs: Any) -> Any:
        raise OSError("binary missing")

    monkeypatch.setattr(subprocess, "Popen", fail_popen)
    with pytest.raises(OSError, match="binary missing"):
        backend.launch_tile(
            MediaTileConfig(
                id="youtube",
                label="YouTube",
                kind="browser_app",
                target="https://youtube.com",
            ),
            "brave-browser",
        )
    assert ["swaymsg", "workspace", "2:media"] not in run_calls
    assert backend.is_active_alive() is False

    # Immediate non-zero exit raises RuntimeError and never focuses 2:media
    class DeadImmediatelyProc:
        def poll(self) -> int:
            return 127

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: DeadImmediatelyProc())
    with pytest.raises(RuntimeError, match="exited immediately with code 127"):
        backend.launch_tile(
            MediaTileConfig(
                id="stremio",
                label="Stremio",
                kind="native_app",
                target="stremio",
            ),
            "brave-browser",
        )
    assert ["swaymsg", "workspace", "2:media"] not in run_calls
    assert backend.is_active_alive() is False


def test_media_service_switch_when_inactive_and_close_media_and_callbacks() -> None:
    clock = FakeClock()
    comp = MockCompositorBackend()
    night = AmbientNightModeController(MockAmbientBackend(), NightModeConfig(), clock=clock)
    tiles = [
        MediaTileConfig(id="anime", label="Anime", kind="browser_app", target="https://anime.test"),
        MediaTileConfig(id="stremio", label="Stremio", kind="native_app", target="stremio"),
    ]
    changes: list[str] = []
    svc = MediaService(
        comp,
        tiles,
        "brave-browser",
        night,
        clock=clock,
        on_state_change=lambda: changes.append("changed"),
    )

    svc.launch_tile("anime")
    assert comp.launched_tile is not None and comp.launched_tile.id == "anime"

    # Simulate process appearing dead (e.g., wrapper forked or exited) while tile_id is still set
    comp._active_alive = False
    svc.launch_tile("stremio")
    assert comp.paused_count == 1
    assert comp.closed_count == 1
    assert comp.launched_tile is not None and comp.launched_tile.id == "stremio"
    assert svc.state.active_tile_id == "stremio"

    # Unexpected exit triggers on_exit -> clears session and fires on_state_change callback
    assert comp._on_exit is not None
    comp._active_alive = False
    comp._on_exit()
    assert changes == ["changed"]
    assert svc._state.active_tile_id is None
    assert svc._state.active_workspace == "1:hub"
    assert night.state.paused_for_video is False

    # Reconcile external exit returns True only when an active tile became dead
    assert svc.reconcile_external_exit() is False
    svc.launch_tile("anime")
    assert svc.reconcile_external_exit() is False
    comp._active_alive = False
    assert svc.reconcile_external_exit() is True
    assert svc._state.active_tile_id is None
    assert svc._state.active_workspace == "1:hub"

    # close_media pauses MPRIS, kills workspace 2, focuses Hub, and clears active state
    svc.launch_tile("stremio")
    closed_state = svc.close_media()
    assert closed_state.active_tile_id is None
    assert closed_state.active_workspace == "1:hub"
    assert comp.workspace == "1:hub"
    assert comp.closed_count == 2
    assert night.state.paused_for_video is False


def test_sway_backend_close_kills_pgid_escalates_sigkill_and_flatpak(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_calls: list[list[str]] = []
    signals_sent: list[tuple[int, signal.Signals]] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        run_calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    class StubbornProc:
        def __init__(self) -> None:
            self.pid = 42424
            self.returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            if self.returncode is None:
                raise subprocess.TimeoutExpired(cmd="stremio", timeout=timeout or 0.0)
            return self.returncode

    def fake_killpg(pid: int, sig: int) -> None:
        signals_sent.append((pid, signal.Signals(sig)))
        if sig == signal.SIGKILL:
            proc.returncode = -9

    proc = StubbornProc()
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: proc)
    monkeypatch.setattr(os, "killpg", fake_killpg)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        shutil,
        "which",
        lambda name: "/usr/bin/flatpak" if name == "flatpak" else None,
    )

    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    backend.launch_tile(
        MediaTileConfig(id="stremio", label="Stremio", kind="native_app", target="stremio"),
        "brave-browser",
    )
    backend.close_media_workspace()

    assert signals_sent == [(42424, signal.SIGTERM), (42424, signal.SIGKILL)]
    assert ["swaymsg", '[workspace="2:media"]', "kill"] in run_calls
    assert ["flatpak", "kill", "com.stremio.Stremio"] in run_calls


def test_sway_backend_tree_inspection_helpers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tree = {
        "type": "root",
        "nodes": [
            {
                "type": "output",
                "name": "eDP-1",
                "nodes": [
                    {
                        "type": "workspace",
                        "name": "1:hub",
                        "focused": False,
                        "nodes": [
                            {"type": "con", "app_id": "chromium", "pid": 100, "focused": False}
                        ],
                        "floating_nodes": [],
                    },
                    {
                        "type": "workspace",
                        "name": "2:media",
                        "focused": False,
                        "nodes": [
                            {"type": "con", "app_id": "surface-media", "pid": 200, "focused": True}
                        ],
                        "floating_nodes": [],
                    },
                ],
            }
        ],
    }

    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(tree).encode()),
    )

    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    assert backend.workspace_has_windows("2:media") is True
    assert backend.workspace_has_windows("1:hub") is True
    assert backend.workspace_has_windows("3:other") is False
    assert backend.focused_workspace() == "2:media"

    # Unavailable swaymsg returns None safely
    def fail_run(*args: Any, **kwargs: Any) -> Any:
        raise OSError("swaymsg not found")

    monkeypatch.setattr(subprocess, "run", fail_run)
    assert backend.workspace_has_windows("2:media") is None
    assert backend.focused_workspace() is None


def test_sway_backend_orphan_window_and_dead_window_watchdog(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tree_with_media_window = {
        "type": "root",
        "nodes": [
            {
                "type": "output",
                "name": "eDP-1",
                "nodes": [
                    {
                        "type": "workspace",
                        "name": "2:media",
                        "nodes": [{"type": "con", "app_id": "surface-media", "pid": 111}],
                        "floating_nodes": [],
                    }
                ],
            }
        ],
    }
    tree_empty = {"type": "root", "nodes": [{"type": "output", "name": "eDP-1", "nodes": []}]}

    current_tree = tree_with_media_window
    events: list[str] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        events.append(" ".join(cmd))
        if cmd == ["swaymsg", "-t", "get_tree", "-r"]:
            return subprocess.CompletedProcess(
                cmd, 0, stdout=json.dumps(current_tree).encode()
            )
        return subprocess.CompletedProcess(cmd, 0)

    class AliveProc:
        def __init__(self) -> None:
            self.returncode: int | None = None
            self.terminated = False

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            self.terminated = True
            self.returncode = -15

    proc = AliveProc()
    clock = FakeClock(start=1000.0)
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: proc)
    monkeypatch.setattr(time, "monotonic", clock)

    backend = SwayCompositorBackend(runtime_dir=tmp_path)
    assert backend._active_proc is None

    # Orphaned window on 2:media (with _active_proc is None) must be killed before launching Stremio
    backend.launch_tile(
        MediaTileConfig(id="stremio", label="Stremio", kind="native_app", target="stremio"),
        "brave-browser",
    )
    assert events == [
        "swaymsg -t get_tree -r",
        'swaymsg [workspace="2:media"] kill',
        "swaymsg workspace 2:media",
    ]

    # Within 5s grace window, empty 2:media still reports alive
    current_tree = tree_empty
    clock.advance(4.0)
    assert backend.is_active_alive() is True
    assert proc.terminated is False

    # Past 5s with 0 windows on 2:media, watchdog closes media workspace and returns False
    clock.advance(2.0)
    assert backend.is_active_alive() is False
    assert proc.terminated is True
    assert events[-1] == 'swaymsg [workspace="2:media"] kill'


def test_media_service_reconcile_external_exit_focuses_hub_only_from_media(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = FakeClock()
    comp = MockCompositorBackend()
    focus_calls: list[str] = []
    orig_focus = comp.focus_workspace

    def tracking_focus(ws: Any) -> None:
        focus_calls.append(str(ws))
        orig_focus(ws)

    monkeypatch.setattr(comp, "focus_workspace", tracking_focus)
    night = AmbientNightModeController(MockAmbientBackend(), NightModeConfig(), clock=clock)
    tiles = [
        MediaTileConfig(
            id="youtube", label="YouTube", kind="browser_app", target="https://youtube.com"
        ),
    ]
    svc = MediaService(comp, tiles, "brave-browser", night, clock=clock)

    # Case 1: stranded on 2:media -> reconcile focuses 1:hub before clearing
    svc.launch_tile("youtube")
    focus_calls.clear()
    comp._active_alive = False
    assert svc.reconcile_external_exit() is True
    assert focus_calls == ["1:hub"]
    assert comp.workspace == "1:hub"
    assert svc._state.active_tile_id is None
    assert svc._state.active_workspace == "1:hub"

    # Case 2: already on 1:hub -> reconcile clears session without extra focus call
    svc.launch_tile("youtube")
    svc.return_home()
    focus_calls.clear()
    comp._active_alive = False
    assert svc.reconcile_external_exit() is True
    assert focus_calls == []
    assert svc._state.active_tile_id is None


@pytest.mark.asyncio
async def test_knowledge_service_duckduckgo_weather_and_error_handling() -> None:
    mode = "ddg_answer"

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if mode == "timeout":
            raise httpx.ReadTimeout("timed out", request=request)
        if mode == "http_500":
            return httpx.Response(500, json={"error": "server"})
        if "api.open-meteo.com" in url:
            return httpx.Response(
                200,
                json={"current": {"temperature_2m": 24.6, "weather_code": 0}},
            )
        if "en.wikipedia.org" in url:
            return httpx.Response(200, json=["q", []])
        if "api.duckduckgo.com" in url:
            if mode == "ddg_answer":
                return httpx.Response(
                    200,
                    json={"Answer": "42 is the answer. Second sentence. Third."},
                )
            if mode == "ddg_abstract":
                return httpx.Response(
                    200,
                    json={"Answer": "", "AbstractText": "First fact. Second fact. Ignored."},
                )
            return httpx.Response(200, json={"Answer": "", "AbstractText": "", "Definition": ""})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        svc = KnowledgeService(17.3850, 78.4867, client=client)

        blank = await svc.answer_query("   ")
        assert blank.source == "none" and blank.answer is None

        weather_ans = await svc.answer_query("What is the weather outside?")
        assert weather_ans.source == "open_meteo"
        assert weather_ans.answer == "It is currently 25 degrees Celsius and clear."

        ddg_ans = await svc.answer_query("Meaning of life")
        assert ddg_ans.source == "duckduckgo"
        assert ddg_ans.answer == "42 is the answer. Second sentence."

        mode = "ddg_abstract"
        abs_ans = await svc.answer_query("Something else")
        assert abs_ans.source == "duckduckgo"
        assert abs_ans.answer == "First fact. Second fact."

        mode = "ddg_empty"
        none_ans = await svc.answer_query("Unknown thing")
        assert none_ans.source == "none" and none_ans.answer is None

        mode = "http_500"
        assert await svc.fetch_weather() is None
        err_ans = await svc.answer_query("Server failure")
        assert err_ans.source == "none" and err_ans.answer is None

        mode = "timeout"
        assert await svc.fetch_weather() is None
        timeout_ans = await svc.answer_query("Timeout query")
        assert timeout_ans.source == "none" and timeout_ans.answer is None


def test_load_config_example_fallback_env_expansion_and_platform_resolution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Missing config_path falls back to config.example.yaml and expands EnvSettings vars
    monkeypatch.setattr(sys, "platform", "darwin")
    env = EnvSettings(
        hardware_backend="auto",
        anime_portal_url="https://anime.example.org",
        primary_phone_name="Pixel Test",
        wallpapers_dir="~/custom-walls",
    )
    fallback_cfg = load_config(config_path=tmp_path / "does-not-exist.yaml", env_settings=env)
    assert fallback_cfg.resolved_backend == "mock"
    assert fallback_cfg.yaml_cfg.kde_connect.primary_phone_name == "Pixel Test"
    anime_tiles = [t for t in fallback_cfg.yaml_cfg.launcher.tiles if t.id == "anime"]
    assert anime_tiles and anime_tiles[0].target == "https://anime.example.org"

    # Auto backend resolves to linux when sys.platform starts with linux
    monkeypatch.setattr(sys, "platform", "linux")
    linux_auto_cfg = load_config(config_path=tmp_path / "missing.yaml", env_settings=env)
    assert linux_auto_cfg.resolved_backend == "linux"

    # Explicit hardware_backend overrides auto detection
    explicit_mock = load_config(
        config_path=tmp_path / "missing.yaml",
        env_settings=EnvSettings(hardware_backend="mock"),
    )
    assert explicit_mock.resolved_backend == "mock"

    # Custom YAML expands both EnvSettings and process os.environ variables
    monkeypatch.setenv("CUSTOM_BROWSER_BIN", "/usr/local/bin/brave-custom")
    custom_yaml = tmp_path / "custom.yaml"
    custom_yaml.write_text(
        'launcher:\n  browser_bin: "${CUSTOM_BROWSER_BIN}"\n'
        'audio:\n  defaults:\n    media_sink_percent: 45\n',
        encoding="utf-8",
    )
    custom_cfg = load_config(config_path=custom_yaml, env_settings=env)
    assert custom_cfg.yaml_cfg.launcher.browser_bin == "/usr/local/bin/brave-custom"
    assert custom_cfg.yaml_cfg.audio_defaults.media_sink_percent == 45
