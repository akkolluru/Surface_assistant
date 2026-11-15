"""FastAPI + WebSocket entry point for the Surface Assistant Companion Daemon."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from daemon.ambient_light import (
    AmbientHardwareBackend,
    AmbientNightModeController,
    LinuxAmbientBackend,
    MockAmbientBackend,
)
from daemon.audio_control import (
    AudioHardwareBackend,
    AudioService,
    MockAudioBackend,
    PipeWireAudioBackend,
)
from daemon.config import AppConfig, load_config
from daemon.kde_bridge import KdeBackend, KdeConnectCliBackend, MockKdeBackend
from daemon.knowledge import KnowledgeService
from daemon.media_launcher import (
    CompositorBackend,
    MediaService,
    MockCompositorBackend,
    SwayCompositorBackend,
)
from daemon.models import (
    AudioLevelRequest,
    ConnectedDevice,
    DaemonEvent,
    DaemonStateSnapshot,
    KnowledgeQueryRequest,
    KnowledgeQueryResponse,
    LaunchMediaRequest,
    NightModeRequest,
    RockerRequest,
    SleepTimerRequest,
    SmsRequest,
    WeatherState,
    WhatsAppReplyRequest,
)
from daemon.wallpapers import WallpaperService

_LOGGER = logging.getLogger(__name__)


class ConnectionManager:
    """Tracks active frontend WebSocket clients and broadcasts typed envelopes."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.discard(ws)

    async def broadcast(self, event: DaemonEvent) -> None:
        if not self._connections:
            return
        payload = event.model_dump()
        dead: list[WebSocket] = []
        for ws in list(self._connections):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections.discard(ws)


@dataclass
class DaemonRuntime:
    """Container holding all initialized services for the running daemon."""

    config: AppConfig
    night_mode: AmbientNightModeController
    audio: AudioService
    media: MediaService
    kde: KdeBackend
    knowledge: KnowledgeService
    wallpapers: WallpaperService
    ws_manager: ConnectionManager = field(default_factory=ConnectionManager)
    devices: list[ConnectedDevice] = field(default_factory=list)
    weather: WeatherState | None = None

    def snapshot(self) -> DaemonStateSnapshot:
        return DaemonStateSnapshot(
            clock_format=self.config.yaml_cfg.display.clock_format,
            temperature_unit=self.config.yaml_cfg.display.temperature_unit,
            night_mode=self.night_mode.state,
            audio=self.audio.get_state(),
            media=self.media.state,
            devices=list(self.devices),
            weather=self.weather,
            wallpapers=self.wallpapers.state,
            tiles=list(self.config.yaml_cfg.launcher.tiles),
        )

    async def broadcast_state(self) -> None:
        await self.ws_manager.broadcast(
            DaemonEvent(type="state", payload=self.snapshot().model_dump())
        )


def build_runtime(config: AppConfig | None = None) -> DaemonRuntime:
    cfg = config or load_config()
    ambient_backend: AmbientHardwareBackend
    audio_backend: AudioHardwareBackend
    compositor_backend: CompositorBackend
    kde_backend: KdeBackend
    if cfg.resolved_backend == "linux":
        ambient_backend = LinuxAmbientBackend()
        audio_backend = PipeWireAudioBackend(cfg.yaml_cfg.audio_defaults)
        compositor_backend = SwayCompositorBackend()
        kde_backend = KdeConnectCliBackend()
    else:
        ambient_backend = MockAmbientBackend()
        audio_backend = MockAudioBackend(cfg.yaml_cfg.audio_defaults)
        compositor_backend = MockCompositorBackend()
        kde_backend = MockKdeBackend()

    night_mode = AmbientNightModeController(ambient_backend, cfg.yaml_cfg.display.night_mode)
    audio = AudioService(audio_backend)
    media = MediaService(
        backend=compositor_backend,
        tiles=cfg.yaml_cfg.launcher.tiles,
        browser_bin=cfg.yaml_cfg.launcher.browser_bin,
        night_mode=night_mode,
    )
    knowledge = KnowledgeService(cfg.env.weather_lat, cfg.env.weather_lon)
    wallpapers = WallpaperService(
        cfg.wallpapers_path,
        interval_seconds=cfg.yaml_cfg.display.wallpaper_interval_seconds,
    )

    runtime = DaemonRuntime(
        config=cfg,
        night_mode=night_mode,
        audio=audio,
        media=media,
        kde=kde_backend,
        knowledge=knowledge,
        wallpapers=wallpapers,
        devices=kde_backend.list_devices(),
    )
    return runtime


async def _poll_ambient_loop(runtime: DaemonRuntime) -> None:
    while True:
        await asyncio.sleep(2.0)
        if runtime.night_mode.poll_once():
            await runtime.broadcast_state()


async def _sleep_timer_loop(runtime: DaemonRuntime) -> None:
    while True:
        await asyncio.sleep(1.0)
        had_timer = runtime.media.state.sleep_timer_remaining_seconds is not None
        expired = runtime.media.tick_sleep_timer()
        if expired or had_timer:
            await runtime.broadcast_state()


async def _kde_poll_loop(runtime: DaemonRuntime) -> None:
    while True:
        await asyncio.sleep(15.0)
        devices = await asyncio.to_thread(runtime.kde.list_devices)
        if devices != runtime.devices:
            runtime.devices = devices
            await runtime.broadcast_state()


async def _weather_poll_loop(runtime: DaemonRuntime) -> None:
    while True:
        weather = await runtime.knowledge.fetch_weather()
        if weather is not None:
            runtime.weather = weather
            await runtime.broadcast_state()
        await asyncio.sleep(900.0)


async def _wallpaper_rotate_loop(runtime: DaemonRuntime) -> None:
    interval = max(15, runtime.config.yaml_cfg.display.wallpaper_interval_seconds)
    while True:
        await asyncio.sleep(interval)
        runtime.wallpapers.next_wallpaper()
        await runtime.broadcast_state()


def create_app(
    runtime: DaemonRuntime | None = None,
    *,
    enable_background_tasks: bool = True,
) -> FastAPI:
    rt = runtime or build_runtime()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        tasks: list[asyncio.Task[None]] = []
        if enable_background_tasks:
            tasks = [
                asyncio.create_task(_poll_ambient_loop(rt)),
                asyncio.create_task(_sleep_timer_loop(rt)),
                asyncio.create_task(_kde_poll_loop(rt)),
                asyncio.create_task(_weather_poll_loop(rt)),
                asyncio.create_task(_wallpaper_rotate_loop(rt)),
            ]
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await rt.knowledge.close()

    app = FastAPI(title="Surface Assistant Daemon", version="1.0.0", lifespan=lifespan)
    app.state.runtime = rt

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:8000",
            "http://localhost:8000",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "backend": rt.config.resolved_backend}

    @app.get("/api/state", response_model=DaemonStateSnapshot)
    async def get_state() -> DaemonStateSnapshot:
        return rt.snapshot()

    @app.get("/api/ha-config")
    async def get_ha_config() -> dict[str, str]:
        return {"url": rt.config.env.ha_url, "token": rt.config.env.ha_token}

    @app.post("/api/night-mode")
    async def set_night_mode(body: NightModeRequest) -> dict[str, Any]:
        state = rt.night_mode.set_manual_override(body.enabled)
        await rt.broadcast_state()
        return state.model_dump()

    @app.post("/api/audio/level")
    async def set_audio_level(body: AudioLevelRequest) -> dict[str, Any]:
        audio_state = rt.audio.set_level(
            body.channel, percent=body.percent, muted=body.muted
        )
        await rt.broadcast_state()
        await rt.ws_manager.broadcast(
            DaemonEvent(
                type="osd",
                payload={"channel": body.channel, "audio": audio_state.model_dump()},
            )
        )
        return audio_state.model_dump()

    @app.post("/api/audio/rocker")
    async def handle_rocker(body: RockerRequest) -> dict[str, Any]:
        audio_state = rt.audio.handle_rocker(body.action)
        await rt.broadcast_state()
        await rt.ws_manager.broadcast(
            DaemonEvent(
                type="osd",
                payload={"channel": "media", "audio": audio_state.model_dump()},
            )
        )
        return audio_state.model_dump()

    @app.post("/api/media/launch")
    async def launch_media(body: LaunchMediaRequest) -> dict[str, Any]:
        try:
            media_state = rt.media.launch_tile(body.tile_id)
        except KeyError as err:
            raise HTTPException(status_code=404, detail=str(err)) from err
        await rt.broadcast_state()
        return media_state.model_dump()

    @app.post("/api/media/home")
    async def return_home() -> dict[str, Any]:
        media_state = rt.media.return_home()
        await rt.broadcast_state()
        return media_state.model_dump()

    @app.post("/api/sleep-timer")
    async def set_sleep_timer(body: SleepTimerRequest) -> dict[str, Any]:
        media_state = rt.media.set_sleep_timer(body.minutes)
        await rt.broadcast_state()
        return media_state.model_dump()

    @app.post("/api/wallpapers/next")
    async def next_wallpaper() -> dict[str, Any]:
        wp_state = rt.wallpapers.next_wallpaper()
        await rt.broadcast_state()
        return wp_state.model_dump()

    @app.get("/api/wallpapers/file/{item_id}")
    async def get_wallpaper_file(item_id: str) -> FileResponse:
        file_path = rt.wallpapers.resolve_file(item_id)
        if file_path is None or not file_path.exists():
            raise HTTPException(status_code=404, detail="Wallpaper not found")
        return FileResponse(path=file_path)

    @app.post("/api/kde/sms")
    async def send_sms(body: SmsRequest) -> dict[str, Any]:
        ok, detail = await asyncio.to_thread(rt.kde.send_sms, body.recipient, body.message)
        if not ok:
            raise HTTPException(status_code=502, detail=detail)
        await rt.ws_manager.broadcast(DaemonEvent(type="toast", payload={"message": detail}))
        return {"ok": True, "detail": detail}

    @app.post("/api/kde/reply")
    async def reply_whatsapp(body: WhatsAppReplyRequest) -> dict[str, Any]:
        ok, detail = await asyncio.to_thread(
            rt.kde.reply_whatsapp, body.sender, body.message
        )
        if not ok:
            raise HTTPException(status_code=502, detail=detail)
        await rt.ws_manager.broadcast(DaemonEvent(type="toast", payload={"message": detail}))
        return {"ok": True, "detail": detail}

    @app.post("/api/knowledge/query", response_model=KnowledgeQueryResponse)
    async def knowledge_query(body: KnowledgeQueryRequest) -> KnowledgeQueryResponse:
        return await rt.knowledge.answer_query(body.query)

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket) -> None:
        await rt.ws_manager.connect(ws)
        try:
            await ws.send_json(
                DaemonEvent(type="state", payload=rt.snapshot().model_dump()).model_dump()
            )
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            rt.ws_manager.disconnect(ws)

    dist_dir: Path = rt.config.frontend_dist_path
    if dist_dir.exists() and (dist_dir / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="frontend")

    return app


app = create_app()
