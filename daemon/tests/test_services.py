"""Tests for media launcher, sleep timer, wallpapers, and knowledge service."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from daemon.ambient_light import AmbientNightModeController, MockAmbientBackend
from daemon.config import NightModeConfig
from daemon.knowledge import KnowledgeService
from daemon.media_launcher import MediaService, MockCompositorBackend
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
