"""FastAPI endpoint & WebSocket contract tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient

from daemon.config import EnvSettings, load_config
from daemon.knowledge import KnowledgeService
from daemon.main import DaemonRuntime, build_runtime, create_app
from daemon.media_launcher import MockCompositorBackend


def _make_test_runtime_and_client(tmp_path: Path) -> tuple[DaemonRuntime, TestClient]:
    env = EnvSettings(
        hardware_backend="mock",
        wallpapers_dir=str(tmp_path),
        ha_token="test-token",
    )
    cfg = load_config(env_settings=env)
    runtime = build_runtime(cfg)
    app = create_app(runtime, enable_background_tasks=False)
    return runtime, TestClient(app)


def _make_test_client(tmp_path: Path) -> TestClient:
    _, client = _make_test_runtime_and_client(tmp_path)
    return client


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


def test_media_close_and_launch_error_endpoints(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, raw_client = _make_test_runtime_and_client(tmp_path)
    with raw_client as client:
        launch = client.post("/api/media/launch", json={"tile_id": "youtube"})
        assert launch.status_code == 200
        assert launch.json()["active_tile_id"] == "youtube"
        assert launch.json()["active_workspace"] == "2:media"

        with client.websocket_connect("/ws") as ws:
            initial = ws.receive_json()
            assert initial["payload"]["media"]["active_tile_id"] == "youtube"

            closed = client.post("/api/media/close")
            assert closed.status_code == 200
            assert closed.json()["active_tile_id"] is None
            assert closed.json()["active_workspace"] == "1:hub"

            ws_after_close = ws.receive_json()
            assert ws_after_close["type"] == "state"
            assert ws_after_close["payload"]["media"]["active_tile_id"] is None
            assert ws_after_close["payload"]["media"]["active_workspace"] == "1:hub"

            # Launch failure (OSError / ValueError / RuntimeError) returns 500 and clears state
            assert client.post("/api/media/launch", json={"tile_id": "youtube"}).status_code == 200
            _ = ws.receive_json()

            def _raise_os_error(*args: Any, **kwargs: Any) -> None:
                raise OSError("brave binary missing")

            monkeypatch.setattr(runtime.media._backend, "launch_tile", _raise_os_error)
            failed = client.post("/api/media/launch", json={"tile_id": "netflix"})
            assert failed.status_code == 500
            assert "Failed to launch netflix: brave binary missing" in failed.json()["detail"]

            ws_after_fail = ws.receive_json()
            assert ws_after_fail["type"] == "state"
            assert ws_after_fail["payload"]["media"]["active_tile_id"] is None
            assert ws_after_fail["payload"]["media"]["active_workspace"] == "1:hub"

            state = client.get("/api/state").json()
            assert state["media"]["active_tile_id"] is None
            assert state["media"]["active_workspace"] == "1:hub"

            def _raise_value_error(*args: Any, **kwargs: Any) -> None:
                raise ValueError("Empty target")

            monkeypatch.setattr(runtime.media._backend, "launch_tile", _raise_value_error)
            val_err = client.post("/api/media/launch", json={"tile_id": "netflix"})
            assert val_err.status_code == 500
            assert "Failed to launch netflix: Empty target" in val_err.json()["detail"]


def test_lifespan_wires_on_state_change_broadcast(tmp_path: Path) -> None:
    runtime, raw_client = _make_test_runtime_and_client(tmp_path)
    with raw_client as client:
        assert runtime.media._on_state_change is not None
        with client.websocket_connect("/ws") as ws:
            _ = ws.receive_json()
            assert client.post("/api/media/launch", json={"tile_id": "youtube"}).status_code == 200
            launched_msg = ws.receive_json()
            assert launched_msg["payload"]["media"]["active_tile_id"] == "youtube"

            # Simulate unexpected backend exit firing _on_exit -> _on_state_change -> ws broadcast
            backend = runtime.media._backend
            assert isinstance(backend, MockCompositorBackend)
            assert backend._on_exit is not None
            backend._active_alive = False
            backend._on_exit()

            exited_msg = ws.receive_json()
            assert exited_msg["type"] == "state"
            assert exited_msg["payload"]["media"]["active_tile_id"] is None
            assert exited_msg["payload"]["media"]["active_workspace"] == "1:hub"



def test_remaining_endpoints_ws_osd_dead_client_pruning_and_kde_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "one.jpg").write_bytes(b"img-one")
    (static_dir / "two.jpg").write_bytes(b"img-two")

    runtime, raw_client = _make_test_runtime_and_client(tmp_path)

    def kb_handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "action=opensearch" in url:
            return httpx.Response(200, json=["q", ["Jupiter"]])
        if "rest_v1/page/summary" in url:
            return httpx.Response(
                200,
                json={"extract": "Jupiter is the largest planet in the Solar System."},
            )
        return httpx.Response(404)

    mock_client = httpx.AsyncClient(transport=httpx.MockTransport(kb_handler))
    monkeypatch.setattr(runtime, "knowledge", KnowledgeService(17.0, 78.0, client=mock_client))

    class DeadWebSocket:
        async def send_json(self, payload: dict[str, Any]) -> None:
            raise RuntimeError("broken pipe")

    with raw_client as client:
        ha_cfg = client.get("/api/ha-config")
        assert ha_cfg.status_code == 200
        assert ha_cfg.json()["token"] == "test-token"

        with client.websocket_connect("/ws") as ws:
            _ = ws.receive_json()  # initial state

            # Register a broken WS client to verify pruning during broadcast
            dead_ws = cast(WebSocket, DeadWebSocket())
            runtime.ws_manager._connections.add(dead_ws)
            assert dead_ws in runtime.ws_manager._connections

            # /api/night-mode
            nm = client.post("/api/night-mode", json={"enabled": True})
            assert nm.status_code == 200
            assert nm.json()["enabled"] is True
            assert nm.json()["manual_override"] is True
            nm_ws = ws.receive_json()
            assert nm_ws["type"] == "state"
            assert nm_ws["payload"]["night_mode"]["enabled"] is True
            assert dead_ws not in runtime.ws_manager._connections

            # /api/audio/level emits state + osd
            lvl = client.post(
                "/api/audio/level",
                json={"channel": "alarm", "percent": 90, "muted": True},
            )
            assert lvl.status_code == 200
            assert lvl.json()["alarm_percent"] == 90
            assert lvl.json()["alarm_muted"] is True
            assert ws.receive_json()["type"] == "state"
            osd_lvl = ws.receive_json()
            assert osd_lvl["type"] == "osd"
            assert osd_lvl["payload"]["channel"] == "alarm"
            assert osd_lvl["payload"]["audio"]["alarm_percent"] == 90

            # /api/audio/rocker emits state + osd on media channel
            rocker = client.post("/api/audio/rocker", json={"action": "down"})
            assert rocker.status_code == 200
            assert rocker.json()["media_percent"] == 55
            assert ws.receive_json()["type"] == "state"
            osd_rocker = ws.receive_json()
            assert osd_rocker["type"] == "osd"
            assert osd_rocker["payload"]["channel"] == "media"
            assert osd_rocker["payload"]["audio"]["media_percent"] == 55

            # /api/media/home keeps active_tile_id while focusing 1:hub
            assert client.post("/api/media/launch", json={"tile_id": "youtube"}).status_code == 200
            _ = ws.receive_json()
            home = client.post("/api/media/home")
            assert home.status_code == 200
            assert home.json()["active_workspace"] == "1:hub"
            assert home.json()["active_tile_id"] == "youtube"
            home_ws = ws.receive_json()
            assert home_ws["payload"]["media"]["active_workspace"] == "1:hub"

            # /api/sleep-timer
            timer = client.post("/api/sleep-timer", json={"minutes": 10})
            assert timer.status_code == 200
            assert 590 <= timer.json()["sleep_timer_remaining_seconds"] <= 600
            assert ws.receive_json()["type"] == "state"

            cleared_timer = client.post("/api/sleep-timer", json={"minutes": 0})
            assert cleared_timer.status_code == 200
            assert cleared_timer.json()["sleep_timer_remaining_seconds"] is None
            assert ws.receive_json()["type"] == "state"

            # /api/wallpapers/next
            wp_next = client.post("/api/wallpapers/next")
            assert wp_next.status_code == 200
            assert wp_next.json()["current_index"] == 1
            assert ws.receive_json()["payload"]["wallpapers"]["current_index"] == 1

            # /api/kde/sms & /api/kde/reply success toast broadcasts
            sms_ok = client.post(
                "/api/kde/sms",
                json={"recipient": "+15550100", "message": "Hi"},
            )
            assert sms_ok.status_code == 200
            assert sms_ok.json()["ok"] is True
            sms_toast = ws.receive_json()
            assert sms_toast["type"] == "toast"
            assert "+15550100" in sms_toast["payload"]["message"]

            wa_ok = client.post(
                "/api/kde/reply",
                json={"sender": "Alice", "message": "Omw"},
            )
            assert wa_ok.status_code == 200
            assert wa_ok.json()["ok"] is True
            wa_toast = ws.receive_json()
            assert wa_toast["type"] == "toast"
            assert "Alice" in wa_toast["payload"]["message"]

        # KDE failure paths return HTTP 502
        monkeypatch.setattr(runtime.kde, "send_sms", lambda *a: (False, "No phone"))
        sms_err = client.post("/api/kde/sms", json={"recipient": "+15550100", "message": "Hi"})
        assert sms_err.status_code == 502
        assert sms_err.json()["detail"] == "No phone"

        monkeypatch.setattr(runtime.kde, "reply_whatsapp", lambda *a: (False, "No notif"))
        wa_err = client.post("/api/kde/reply", json={"sender": "Alice", "message": "Omw"})
        assert wa_err.status_code == 502
        assert wa_err.json()["detail"] == "No notif"

        # /api/knowledge/query
        kb_res = client.post("/api/knowledge/query", json={"query": "Tell me about Jupiter"})
        assert kb_res.status_code == 200
        assert kb_res.json() == {
            "source": "wikipedia",
            "answer": "Jupiter is the largest planet in the Solar System.",
        }


def test_mock_mode_serves_sim_spa_when_dist_exists(tmp_path: Path) -> None:
    dist_dir = tmp_path / "dist"
    dist_dir.mkdir()
    (dist_dir / "index.html").write_text(
        "<html><body>Mock Dist Hub</body></html>",
        encoding="utf-8",
    )

    env = EnvSettings(
        hardware_backend="mock",
        wallpapers_dir=str(tmp_path),
    )
    cfg = load_config(env_settings=env).model_copy(update={"frontend_dist_path": dist_dir})
    runtime = build_runtime(cfg)
    app = create_app(runtime, enable_background_tasks=False)

    with TestClient(app) as client:
        sim_resp = client.get("/sim")
        assert sim_resp.status_code == 200
        assert "Mock Dist Hub" in sim_resp.text

        root_resp = client.get("/")
        assert root_resp.status_code == 200
        assert "Mock Dist Hub" in root_resp.text
