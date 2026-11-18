"""FastAPI endpoint & WebSocket contract tests."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from daemon.config import EnvSettings, load_config
from daemon.main import build_runtime, create_app


def _make_test_client(tmp_path: Path) -> TestClient:
    env = EnvSettings(
        hardware_backend="mock",
        wallpapers_dir=str(tmp_path),
        ha_token="test-token",
    )
    cfg = load_config(env_settings=env)
    runtime = build_runtime(cfg)
    app = create_app(runtime, enable_background_tasks=False)
    return TestClient(app)


def test_rest_and_websocket_state_flow(tmp_path: Path) -> None:
    client = _make_test_client(tmp_path)

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["backend"] == "mock"

    state = client.get("/api/state").json()
    assert len(state["devices"]) == 3
    assert len(state["wallpapers"]["items"]) >= 2

    res = client.post("/api/audio/rocker", json={"action": "up"})
    assert res.status_code == 200
    assert res.json()["media_percent"] == 65

    launch = client.post("/api/media/launch", json={"tile_id": "youtube"})
    assert launch.status_code == 200
    assert launch.json()["active_workspace"] == "2:media"

    missing = client.post("/api/media/launch", json={"tile_id": "unknown"})
    assert missing.status_code == 404

    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "state"
        assert msg["payload"]["media"]["active_tile_id"] == "youtube"

    root_resp = client.get("/")
    assert root_resp.status_code == 200
    assert "Surface Bedside Hub" in root_resp.text


def test_wallpaper_refresh_and_file_endpoints(tmp_path: Path) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "first.jpg").write_bytes(b"jpeg-one")

    client = _make_test_client(tmp_path)
    state = client.get("/api/state").json()
    assert [item["filename"] for item in state["wallpapers"]["items"]] == ["first.jpg"]

    (static_dir / "second.png").write_bytes(b"png-two")
    refreshed = client.post("/api/wallpapers/refresh")
    assert refreshed.status_code == 200
    items = refreshed.json()["items"]
    assert {item["filename"] for item in items} == {"first.jpg", "second.png"}

    for item in items:
        file_resp = client.get(item["url"])
        assert file_resp.status_code == 200

    missing = client.get("/api/wallpapers/file/nonexistent")
    assert missing.status_code == 404
