"""Tests for media launcher, sleep timer, wallpapers, and knowledge service."""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest

from daemon.ambient_light import AmbientNightModeController, MockAmbientBackend
from daemon.config import NightModeConfig
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

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        run_calls.append((cmd, kwargs["env"]))
        return subprocess.CompletedProcess(cmd, 0)

    class FakeProc:
        def poll(self) -> int | None:
            return None

        def terminate(self) -> None:
            return None

    def fake_popen(cmd: list[str], **kwargs: Any) -> FakeProc:
        popen_calls.append((cmd, kwargs["env"]))
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
    assert run_calls[0][0] == ["swaymsg", "workspace", "2:media"]
    assert run_calls[1][0] == ["swaymsg", '[workspace="2:media"]', "fullscreen", "enable"]
    for _, env in run_calls:
        assert env["SWAYSOCK"] == str(sway_sock)
        assert env["WAYLAND_DISPLAY"] == "wayland-1"

    assert len(popen_calls) == 2
    assert popen_calls[0][0][0] == "brave-browser"
    expected_profile = tmp_path / ".local/share/surface-assistant/media-profile"
    assert f"--user-data-dir={expected_profile}" in popen_calls[0][0]
    assert "--app=https://youtube.com" in popen_calls[0][0]
    assert "--class=surface-media" in popen_calls[0][0]
    assert "--ozone-platform=wayland" in popen_calls[0][0]
    assert "--touch-events=enabled" in popen_calls[0][0]
    assert "--password-store=basic" in popen_calls[0][0]
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
