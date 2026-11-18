"""Tests for KDE Connect primary phone pinning and config resolution."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

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



def test_kde_list_devices_and_read_battery_dbus(monkeypatch: MonkeyPatch) -> None:
    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if cmd == ["kdeconnect-cli", "--list-devices"]:
            stdout = "\n".join(
                [
                    "- Google Pixel 10 Pro: pixel-10 (paired and reachable)",
                    "- Work Laptop: laptop-1 (paired and reachable)",
                    "- Galaxy Tab S9: tab-9 (paired)",
                    "unparsed header line",
                ]
            )
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")
        joined = " ".join(cmd)
        if "/devices/pixel-10/battery" in joined and cmd[-1] == "charge":
            return subprocess.CompletedProcess(cmd, 0, stdout="(<84>,)\n", stderr="")
        if "/devices/pixel-10/battery" in joined and cmd[-1] == "isCharging":
            return subprocess.CompletedProcess(cmd, 0, stdout="(<true>,)\n", stderr="")
        if "/devices/laptop-1/battery" in joined and cmd[-1] == "charge":
            return subprocess.CompletedProcess(cmd, 0, stdout="(<-1>,)\n", stderr="")
        if "/devices/laptop-1/battery" in joined and cmd[-1] == "isCharging":
            return subprocess.CompletedProcess(cmd, 0, stdout="(<false>,)\n", stderr="")
        raise AssertionError(f"Unexpected command: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    backend = KdeConnectCliBackend(primary_phone_name="Google Pixel 10 Pro")
    devices = backend.list_devices()

    assert len(devices) == 3
    assert devices[0] == ConnectedDevice(
        id="pixel-10",
        name="Google Pixel 10 Pro",
        device_type="phone",
        reachable=True,
        battery_percent=84,
        charging=True,
    )
    assert devices[1] == ConnectedDevice(
        id="laptop-1",
        name="Work Laptop",
        device_type="laptop",
        reachable=True,
        battery_percent=None,
        charging=False,
    )
    assert devices[2] == ConnectedDevice(
        id="tab-9",
        name="Galaxy Tab S9",
        device_type="tablet",
        reachable=False,
        battery_percent=None,
        charging=False,
    )

    # Missing kdeconnect-cli binary returns empty device list
    def fail_run(*args: Any, **kwargs: Any) -> Any:
        raise FileNotFoundError("kdeconnect-cli missing")

    monkeypatch.setattr(subprocess, "run", fail_run)
    assert backend.list_devices() == []
    assert backend._read_battery_dbus("pixel-10") == (None, False)


def test_kde_reply_whatsapp_success_and_failure_paths(monkeypatch: MonkeyPatch) -> None:
    backend = KdeConnectCliBackend(primary_phone_name="Google Pixel 10 Pro")
    monkeypatch.setattr(
        backend,
        "list_devices",
        lambda: [_phone("pixel-id", "Google Pixel 10 Pro")],
    )

    sent_calls: list[list[str]] = []

    def fake_run(args: list[str], timeout: float = 3.0) -> str | None:
        sent_calls.append(args)
        if args[-1].endswith("activeNotifications"):
            return "(['notif-other', 'notif-wa'],)"
        if args[-1] == "org.kde.kdeconnect.device.notifications.notification":
            if any(arg.endswith("/notif-other") for arg in args):
                return "({'appName': <'Gmail'>, 'title': <'Alice'>},)"
            if any(arg.endswith("/notif-wa") for arg in args):
                return (
                    "({'appName': <'WhatsApp'>, 'title': <'Alice'>, "
                    "'replyId': <'wa-reply-99'>},)"
                )
        if "sendReply" in args[-3]:
            return "()"
        return None

    monkeypatch.setattr(backend, "_run", fake_run)
    ok, detail = backend.reply_whatsapp("Alice", "On my way!")
    assert ok is True
    assert detail == "Replied to Alice on WhatsApp."
    assert any(
        call[-3:] == [
            "org.kde.kdeconnect.device.notifications.sendReply",
            "wa-reply-99",
            "On my way!",
        ]
        for call in sent_calls
    )

    # Non-matching sender returns failure
    ok_missing, msg_missing = backend.reply_whatsapp("Bob", "Hey")
    assert ok_missing is False
    assert msg_missing == "No recent replyable WhatsApp notification from Bob."

    # Empty activeNotifications returns clear error
    monkeypatch.setattr(backend, "_run", lambda args, timeout=3.0: None)
    ok_empty, msg_empty = backend.reply_whatsapp("Alice", "Hello")
    assert ok_empty is False
    assert msg_empty == "No active notifications available to reply to."

    # No reachable phones returns clear error
    monkeypatch.setattr(backend, "list_devices", lambda: [])
    ok_no_phone, msg_no_phone = backend.reply_whatsapp("Alice", "Hello")
    assert ok_no_phone is False
    assert msg_no_phone == "No reachable paired phone found in KDE Connect."
