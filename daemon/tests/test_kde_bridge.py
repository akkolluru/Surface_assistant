"""Tests for KDE Connect primary phone pinning and config resolution."""

from __future__ import annotations

from pathlib import Path

from pytest import MonkeyPatch

from daemon.config import EnvSettings, load_config
from daemon.kde_bridge import KdeConnectCliBackend
from daemon.models import ConnectedDevice, DeviceKind


def _phone(
    dev_id: str,
    name: str,
    *,
    reachable: bool = True,
    device_type: DeviceKind = "phone",
) -> ConnectedDevice:
    return ConnectedDevice(
        id=dev_id,
        name=name,
        device_type=device_type,
        reachable=reachable,
        battery_percent=80 if reachable else None,
        charging=False,
    )


def test_find_phone_id_prefers_exact_case_insensitive_match(monkeypatch: MonkeyPatch) -> None:
    backend = KdeConnectCliBackend(primary_phone_name="  google pixel 10 pro  ")
    devices = [
        _phone("nothing-id", "Nothing Phone 1"),
        _phone("pixel-id", "Google Pixel 10 Pro"),
    ]
    monkeypatch.setattr(backend, "list_devices", lambda: devices)

    assert backend._find_phone_id() == "pixel-id"


def test_find_phone_id_supports_case_insensitive_substring_match(
    monkeypatch: MonkeyPatch,
) -> None:
    backend = KdeConnectCliBackend(primary_phone_name="pixel 10")
    devices = [
        _phone("nothing-id", "Nothing Phone 1"),
        _phone("pixel-id", "Google Pixel 10 Pro"),
    ]
    monkeypatch.setattr(backend, "list_devices", lambda: devices)

    assert backend._find_phone_id() == "pixel-id"


def test_find_phone_id_prefers_exact_match_over_substring_match(
    monkeypatch: MonkeyPatch,
) -> None:
    backend = KdeConnectCliBackend(primary_phone_name="Pixel 10")
    devices = [
        _phone("pixel-pro-id", "Google Pixel 10 Pro"),
        _phone("pixel-exact-id", "pixel 10"),
    ]
    monkeypatch.setattr(backend, "list_devices", lambda: devices)

    assert backend._find_phone_id() == "pixel-exact-id"


def test_find_phone_id_skips_unreachable_primary_phone(monkeypatch: MonkeyPatch) -> None:
    backend = KdeConnectCliBackend(primary_phone_name="Google Pixel 10 Pro")
    devices = [
        _phone("pixel-id", "Google Pixel 10 Pro", reachable=False),
        _phone("nothing-id", "Nothing Phone 1", reachable=True),
    ]
    monkeypatch.setattr(backend, "list_devices", lambda: devices)

    assert backend._find_phone_id() == "nothing-id"


def test_find_phone_id_fallbacks_and_no_reachable_phone(monkeypatch: MonkeyPatch) -> None:
    devices = [
        _phone("laptop-id", "Main Laptop", reachable=True, device_type="laptop"),
        _phone("nothing-id", "Nothing Phone 1", reachable=True),
        _phone("other-id", "Backup Phone", reachable=True),
    ]

    unmatched = KdeConnectCliBackend(primary_phone_name="Missing Phone")
    monkeypatch.setattr(unmatched, "list_devices", lambda: devices)
    assert unmatched._find_phone_id() == "nothing-id"

    blank_primary = KdeConnectCliBackend(primary_phone_name="   ")
    monkeypatch.setattr(blank_primary, "list_devices", lambda: devices)
    assert blank_primary._find_phone_id() == "nothing-id"

    no_primary = KdeConnectCliBackend(primary_phone_name=None)
    monkeypatch.setattr(no_primary, "list_devices", lambda: devices)
    assert no_primary._find_phone_id() == "nothing-id"

    none_reachable = KdeConnectCliBackend(primary_phone_name="Google Pixel 10 Pro")
    monkeypatch.setattr(
        none_reachable,
        "list_devices",
        lambda: [
            _phone("laptop-id", "Main Laptop", reachable=True, device_type="laptop"),
            _phone("pixel-id", "Google Pixel 10 Pro", reachable=False),
        ],
    )
    assert none_reachable._find_phone_id() is None


def test_send_sms_uses_preferred_primary_phone_id(monkeypatch: MonkeyPatch) -> None:
    backend = KdeConnectCliBackend(primary_phone_name="Google Pixel 10 Pro")
    devices = [
        _phone("nothing-id", "Nothing Phone 1"),
        _phone("pixel-id", "Google Pixel 10 Pro"),
    ]
    monkeypatch.setattr(backend, "list_devices", lambda: devices)

    recorded_calls: list[tuple[list[str], float]] = []

    def fake_run(args: list[str], timeout: float = 3.0) -> str | None:
        recorded_calls.append((args, timeout))
        return ""

    monkeypatch.setattr(backend, "_run", fake_run)

    ok, msg = backend.send_sms("+15550100", "Hello from Surface")
    assert ok is True
    assert msg == "SMS sent to +15550100."
    assert recorded_calls == [
        (
            [
                "kdeconnect-cli",
                "-d",
                "pixel-id",
                "--send-sms",
                "Hello from Surface",
                "--destination",
                "+15550100",
            ],
            5.0,
        )
    ]


def test_load_config_resolves_primary_phone_name(tmp_path: Path) -> None:
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(
        'kde_connect:\n  primary_phone_name: "${PRIMARY_PHONE_NAME}"\n',
        encoding="utf-8",
    )
    env = EnvSettings(primary_phone_name="Google Pixel 10 Pro")
    loaded = load_config(config_path=cfg_file, env_settings=env)

    assert loaded.yaml_cfg.kde_connect.primary_phone_name == "Google Pixel 10 Pro"

    custom_env = EnvSettings(primary_phone_name="Custom Pixel")
    loaded_custom = load_config(config_path=cfg_file, env_settings=custom_env)
    assert loaded_custom.yaml_cfg.kde_connect.primary_phone_name == "Custom Pixel"
