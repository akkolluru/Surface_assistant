"""Mac hardware simulator routes (mounted only when resolved_backend == 'mock')."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from daemon.ambient_light import MockAmbientBackend
from daemon.kde_bridge import MockKdeBackend
from daemon.models import DaemonEvent

if TYPE_CHECKING:
    from daemon.main import DaemonRuntime


class SimLuxRequest(BaseModel):
    lux: float = Field(ge=0.0, le=5000.0)
    instant: bool = True


class SimDeviceRequest(BaseModel):
    id: str
    reachable: bool | None = None
    battery_percent: int | None = Field(default=None, ge=0, le=100)
    charging: bool | None = None


def build_simulator_router(
    runtime: DaemonRuntime,
    ambient_backend: MockAmbientBackend,
    kde_backend: MockKdeBackend,
) -> APIRouter:
    """Create interactive simulation endpoints for macOS development."""
    router = APIRouter(prefix="/api/sim", tags=["simulator"])

    @router.post("/lux")
    async def set_lux(body: SimLuxRequest) -> dict[str, Any]:
        ambient_backend.lux = body.lux
        # Clear manual override so sensor transitions can be observed interactively
        if runtime.night_mode.state.manual_override is not None:
            runtime.night_mode.set_manual_override(None)
        runtime.night_mode.poll_once()
        if body.instant:
            runtime.night_mode.fast_forward_debounce(60.0)
        await runtime.broadcast_state()
        return runtime.night_mode.state.model_dump()

    @router.post("/sleep-expire")
    async def expire_sleep_timer() -> dict[str, Any]:
        runtime.media.expire_sleep_timer_now()
        await runtime.broadcast_state()
        await runtime.ws_manager.broadcast(
            DaemonEvent(
                type="toast",
                payload={"message": "Sleep timer expired: media paused, Hub & Night Mode active."},
            )
        )
        return runtime.snapshot().model_dump()

    @router.post("/device")
    async def update_device(body: SimDeviceRequest) -> dict[str, Any]:
        updated = kde_backend.update_device(
            body.id,
            reachable=body.reachable,
            battery_percent=body.battery_percent,
            charging=body.charging,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail=f"Unknown mock device: {body.id}")
        runtime.devices = kde_backend.list_devices()
        await runtime.broadcast_state()
        return updated.model_dump()

    return router
