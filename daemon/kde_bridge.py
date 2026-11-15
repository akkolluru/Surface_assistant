"""KDE Connect CLI & D-Bus bridge for device telemetry, SMS, and WhatsApp replies."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Protocol

from daemon.models import ConnectedDevice, DeviceKind

_LOGGER = logging.getLogger(__name__)
_DEVICE_LINE_RE = re.compile(r"^-\s+(.+?):\s+([a-zA-Z0-9_-]+)\s+\((.+)\)$")


class KdeBackend(Protocol):
    """Abstraction over KDE Connect CLI/D-Bus."""

    def list_devices(self) -> list[ConnectedDevice]:
        """List paired/reachable devices with battery state."""

    def send_sms(self, recipient: str, message: str) -> tuple[bool, str]:
        """Send an SMS via the primary reachable Android phone."""

    def reply_whatsapp(self, sender: str, message: str) -> tuple[bool, str]:
        """Reply to a bridged WhatsApp notification via KDE Connect."""


class MockKdeBackend:
    """Mock device roster matching the PRD's 3 devices for macOS dev & tests."""

    def __init__(self) -> None:
        self.sent_sms: list[tuple[str, str]] = []
        self.whatsapp_replies: list[tuple[str, str]] = []

    def list_devices(self) -> list[ConnectedDevice]:
        return [
            ConnectedDevice(
                id="mock-primary-phone",
                name="Primary Phone",
                device_type="phone",
                reachable=True,
                battery_percent=84,
                charging=False,
            ),
            ConnectedDevice(
                id="mock-nothing-phone",
                name="Nothing Phone 1",
                device_type="phone",
                reachable=True,
                battery_percent=62,
                charging=True,
            ),
            ConnectedDevice(
                id="mock-main-laptop",
                name="Main Laptop",
                device_type="laptop",
                reachable=True,
                battery_percent=91,
                charging=True,
            ),
        ]

    def send_sms(self, recipient: str, message: str) -> tuple[bool, str]:
        self.sent_sms.append((recipient, message))
        return True, f"Mock SMS queued for {recipient}."

    def reply_whatsapp(self, sender: str, message: str) -> tuple[bool, str]:
        self.whatsapp_replies.append((sender, message))
        return True, f"Mock WhatsApp reply queued for {sender}."


class KdeConnectCliBackend:
    """Linux KDE Connect integration via kdeconnect-cli and gdbus."""

    @staticmethod
    def _infer_device_kind(name: str) -> DeviceKind:
        lowered = name.lower()
        if any(tok in lowered for tok in ("mac", "laptop", "thinkpad", "desktop", "pc")):
            return "laptop"
        if "tab" in lowered or "ipad" in lowered:
            return "tablet"
        return "phone"

    def _run(self, args: list[str], timeout: float = 3.0) -> str | None:
        try:
            proc = subprocess.run(
                args,
                check=True,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return proc.stdout
        except (OSError, subprocess.SubprocessError) as err:
            _LOGGER.debug("Command %s failed: %s", args, err)
            return None

    def _read_battery_dbus(self, device_id: str) -> tuple[int | None, bool]:
        charge_out = self._run(
            [
                "gdbus",
                "call",
                "--session",
                "--dest",
                "org.kde.kdeconnect",
                "--object-path",
                f"/modules/kdeconnect/devices/{device_id}/battery",
                "--method",
                "org.freedesktop.DBus.Properties.Get",
                "org.kde.kdeconnect.device.battery",
                "charge",
            ]
        )
        charging_out = self._run(
            [
                "gdbus",
                "call",
                "--session",
                "--dest",
                "org.kde.kdeconnect",
                "--object-path",
                f"/modules/kdeconnect/devices/{device_id}/battery",
                "--method",
                "org.freedesktop.DBus.Properties.Get",
                "org.kde.kdeconnect.device.battery",
                "isCharging",
            ]
        )
        percent: int | None = None
        if charge_out:
            match = re.search(r"(-?\d+)", charge_out)
            if match:
                val = int(match.group(1))
                if 0 <= val <= 100:
                    percent = val
        charging = bool(charging_out and "true" in charging_out.lower())
        return percent, charging

    def list_devices(self) -> list[ConnectedDevice]:
        out = self._run(["kdeconnect-cli", "--list-devices"])
        if not out:
            return []
        devices: list[ConnectedDevice] = []
        for raw_line in out.splitlines():
            match = _DEVICE_LINE_RE.match(raw_line.strip())
            if not match:
                continue
            name, dev_id, flags = match.groups()
            reachable = "reachable" in flags.lower() and "paired" in flags.lower()
            percent, charging = self._read_battery_dbus(dev_id) if reachable else (None, False)
            devices.append(
                ConnectedDevice(
                    id=dev_id,
                    name=name.strip(),
                    device_type=self._infer_device_kind(name),
                    reachable=reachable,
                    battery_percent=percent,
                    charging=charging,
                )
            )
        return devices

    def _find_phone_id(self) -> str | None:
        for dev in self.list_devices():
            if dev.reachable and dev.device_type == "phone":
                return dev.id
        return None

    def send_sms(self, recipient: str, message: str) -> tuple[bool, str]:
        phone_id = self._find_phone_id()
        if phone_id is None:
            return False, "No reachable paired phone found in KDE Connect."
        out = self._run(
            [
                "kdeconnect-cli",
                "-d",
                phone_id,
                "--send-sms",
                message,
                "--destination",
                recipient,
            ],
            timeout=5.0,
        )
        if out is None:
            return False, "Failed sending SMS via KDE Connect."
        return True, f"SMS sent to {recipient}."

    def reply_whatsapp(self, sender: str, message: str) -> tuple[bool, str]:
        phone_id = self._find_phone_id()
        if phone_id is None:
            return False, "No reachable paired phone found in KDE Connect."
        notif_out = self._run(
            [
                "gdbus",
                "call",
                "--session",
                "--dest",
                "org.kde.kdeconnect",
                "--object-path",
                f"/modules/kdeconnect/devices/{phone_id}/notifications",
                "--method",
                "org.kde.kdeconnect.device.notifications.activeNotifications",
            ]
        )
        if not notif_out:
            return False, "No active notifications available to reply to."

        notif_ids = re.findall(r"'([^']+)'", notif_out)
        sender_lower = sender.lower()
        for nid in notif_ids:
            obj_path = f"/modules/kdeconnect/devices/{phone_id}/notifications/{nid}"
            info = self._run(
                [
                    "gdbus",
                    "call",
                    "--session",
                    "--dest",
                    "org.kde.kdeconnect",
                    "--object-path",
                    obj_path,
                    "--method",
                    "org.freedesktop.DBus.Properties.GetAll",
                    "org.kde.kdeconnect.device.notifications.notification",
                ]
            )
            if not info:
                continue
            info_lower = info.lower()
            if "whatsapp" in info_lower and sender_lower in info_lower:
                reply_id_match = re.search(r"'replyId':\s*<'([^']+)'>", info)
                if not reply_id_match:
                    continue
                reply_id = reply_id_match.group(1)
                res = self._run(
                    [
                        "gdbus",
                        "call",
                        "--session",
                        "--dest",
                        "org.kde.kdeconnect",
                        "--object-path",
                        f"/modules/kdeconnect/devices/{phone_id}/notifications",
                        "--method",
                        "org.kde.kdeconnect.device.notifications.sendReply",
                        reply_id,
                        message,
                    ]
                )
                if res is not None:
                    return True, f"Replied to {sender} on WhatsApp."
        return False, f"No recent replyable WhatsApp notification from {sender}."
