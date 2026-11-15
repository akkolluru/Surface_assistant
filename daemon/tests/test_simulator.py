"""Tests for Mac hardware simulator routes and Linux isolation guard."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi.testclient import TestClient

from daemon.config import EnvSettings, load_config
from daemon.main import build_runtime, create_app


def _make_client(
    tmp_path: Path, backend: Literal["auto", "mock", "linux"] = "mock"
) -> TestClient:
    env = EnvSettings(
        hardware_backend=backend,
        wallpapers_dir=str(tmp_path),
    )
    cfg = load_config(env_settings=env)
    runtime = build_runtime(cfg)
    app = create_app(runtime, enable_background_tasks=False)
    return TestClient(app)


def test_simulator_routes_work_in_mock_mode(tmp_path: Path) -> None:
    client = _make_client(tmp_path, backend="mock")

    # Dropping lux engages Night Mode immediately when instant=True
    lux_res = client.post("/api/sim/lux", json={"lux": 2.0, "instant": True})
    assert lux_res.status_code == 200
    assert lux_res.json()["enabled"] is True
    assert lux_res.json()["backlight_percent"] == 3

    # Raising lux exits Night Mode
    day_res = client.post("/api/sim/lux", json={"lux": 120.0, "instant": True})
    assert day_res.status_code == 200
    assert day_res.json()["enabled"] is False

    # Updating mock KDE device reflects in /api/state
    dev_res = client.post(
        "/api/sim/device",
        json={"id": "mock-primary-phone", "battery_percent": 19, "charging": True},
    )
    assert dev_res.status_code == 200
    assert dev_res.json()["battery_percent"] == 19
    assert dev_res.json()["charging"] is True

    # Launching media and expiring sleep timer returns to Hub + enables Night Mode
    client.post("/api/media/launch", json={"tile_id": "youtube"})
    exp_res = client.post("/api/sim/sleep-expire")
    assert exp_res.status_code == 200
    snap = exp_res.json()
    assert snap["media"]["active_workspace"] == "1:hub"
    assert snap["media"]["active_tile_id"] is None
    assert snap["night_mode"]["enabled"] is True

    sim_page = client.get("/sim")
    assert sim_page.status_code == 200
    assert "Surface Bedside Hub" in sim_page.text


def test_simulator_routes_disabled_on_linux_backend(tmp_path: Path) -> None:
    client = _make_client(tmp_path, backend="linux")
    res = client.post("/api/sim/lux", json={"lux": 2.0, "instant": True})
    assert res.status_code in (404, 405)
    assert client.get("/sim").status_code == 404
