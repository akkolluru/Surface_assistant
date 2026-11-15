"""PipeWire modular sink volume control (Alarm, TTS, Media)."""

from __future__ import annotations

import logging
import re
import subprocess
from typing import Protocol

from daemon.config import AudioDefaultsConfig
from daemon.models import AudioChannel, AudioState, RockerAction

_LOGGER = logging.getLogger(__name__)
_VOLUME_RE = re.compile(r"(\d+)%")

SINK_MAP: dict[AudioChannel, str] = {
    "alarm": "alarm-sink",
    "tts": "tts-sink",
    "media": "media-sink",
}


class AudioHardwareBackend(Protocol):
    """Abstraction over PipeWire/PulseAudio volume control."""

    def get_state(self) -> AudioState:
        """Read current volume and mute state for all 3 channels."""

    def set_level(
        self,
        channel: AudioChannel,
        *,
        percent: int | None = None,
        muted: bool | None = None,
    ) -> AudioState:
        """Update volume percentage and/or mute flag for a single channel."""


class MockAudioBackend:
    """In-memory audio backend for macOS development and tests."""

    def __init__(self, defaults: AudioDefaultsConfig | None = None) -> None:
        cfg = defaults or AudioDefaultsConfig()
        self._state = AudioState(
            alarm_percent=cfg.alarm_sink_percent,
            tts_percent=cfg.tts_sink_percent,
            media_percent=cfg.media_sink_percent,
        )

    def get_state(self) -> AudioState:
        return self._state.model_copy()

    def set_level(
        self,
        channel: AudioChannel,
        *,
        percent: int | None = None,
        muted: bool | None = None,
    ) -> AudioState:
        if percent is not None:
            clamped = max(0, min(150, percent))
            setattr(self._state, f"{channel}_percent", clamped)
        if muted is not None:
            setattr(self._state, f"{channel}_muted", muted)
        return self.get_state()


class PipeWireAudioBackend:
    """Controls PipeWire virtual sinks via pactl."""

    def __init__(self, defaults: AudioDefaultsConfig | None = None) -> None:
        self._fallback = MockAudioBackend(defaults)

    def _run_pactl(self, *args: str) -> str | None:
        try:
            proc = subprocess.run(
                ["pactl", *args],
                check=True,
                capture_output=True,
                text=True,
                timeout=2.0,
            )
            return proc.stdout
        except (OSError, subprocess.SubprocessError) as err:
            _LOGGER.debug("pactl %s failed: %s", args, err)
            return None

    def _read_sink(self, sink: str, default_percent: int) -> tuple[int, bool]:
        vol_out = self._run_pactl("get-sink-volume", sink)
        mute_out = self._run_pactl("get-sink-mute", sink)
        percent = default_percent
        if vol_out:
            match = _VOLUME_RE.search(vol_out)
            if match:
                percent = max(0, min(150, int(match.group(1))))
        muted = bool(mute_out and "yes" in mute_out.lower())
        return percent, muted

    def get_state(self) -> AudioState:
        fb = self._fallback.get_state()
        alarm_pct, alarm_muted = self._read_sink(SINK_MAP["alarm"], fb.alarm_percent)
        tts_pct, tts_muted = self._read_sink(SINK_MAP["tts"], fb.tts_percent)
        media_pct, media_muted = self._read_sink(SINK_MAP["media"], fb.media_percent)
        return AudioState(
            alarm_percent=alarm_pct,
            tts_percent=tts_pct,
            media_percent=media_pct,
            alarm_muted=alarm_muted,
            tts_muted=tts_muted,
            media_muted=media_muted,
        )

    def set_level(
        self,
        channel: AudioChannel,
        *,
        percent: int | None = None,
        muted: bool | None = None,
    ) -> AudioState:
        sink = SINK_MAP[channel]
        self._fallback.set_level(channel, percent=percent, muted=muted)
        if percent is not None:
            clamped = max(0, min(150, percent))
            self._run_pactl("set-sink-volume", sink, f"{clamped}%")
        if muted is not None:
            self._run_pactl("set-sink-mute", sink, "1" if muted else "0")
        return self.get_state()


class AudioService:
    """High-level service coordinating volume updates and rocker button increments."""

    def __init__(self, backend: AudioHardwareBackend, step_percent: int = 5) -> None:
        self._backend = backend
        self._step = step_percent

    def get_state(self) -> AudioState:
        return self._backend.get_state()

    def set_level(
        self,
        channel: AudioChannel,
        *,
        percent: int | None = None,
        muted: bool | None = None,
    ) -> AudioState:
        return self._backend.set_level(channel, percent=percent, muted=muted)

    def handle_rocker(self, action: RockerAction) -> AudioState:
        current = self._backend.get_state()
        if action == "mute":
            return self._backend.set_level("media", muted=not current.media_muted)
        delta = self._step if action == "up" else -self._step
        next_percent = max(0, min(100, current.media_percent + delta))
        muted = False if action == "up" else current.media_muted
        return self._backend.set_level("media", percent=next_percent, muted=muted)
