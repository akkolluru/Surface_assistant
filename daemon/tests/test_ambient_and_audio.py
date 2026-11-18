"""Tests for Smart Night Mode controller and PipeWire modular AudioService."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from daemon.ambient_light import (
    AmbientNightModeController,
    LinuxAmbientBackend,
    MockAmbientBackend,
)
from daemon.audio_control import AudioService, MockAudioBackend, PipeWireAudioBackend
from daemon.config import AudioDefaultsConfig, NightModeConfig


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_night_mode_hysteresis_and_debounce() -> None:
    clock = FakeClock()
    backend = MockAmbientBackend(initial_lux=100.0)
    cfg = NightModeConfig(
        enter_lux=5.0,
        exit_lux=15.0,
        enter_debounce_seconds=10.0,
        exit_debounce_seconds=5.0,
        min_backlight_percent=3,
        day_backlight_percent=70,
    )
    ctrl = AmbientNightModeController(backend, cfg, clock=clock)

    backend.lux = 3.0
    ctrl.poll_once()
    assert not ctrl.state.enabled

    clock.advance(9.0)
    ctrl.poll_once()
    assert not ctrl.state.enabled

    clock.advance(1.5)
    ctrl.poll_once()
    assert ctrl.state.enabled
    assert backend.backlight_percent == 3

    # Hysteresis band (between 5 and 15 lux) keeps night mode stable
    backend.lux = 10.0
    clock.advance(20.0)
    ctrl.poll_once()
    assert ctrl.state.enabled

    # Exceeding exit_lux for exit_debounce_seconds restores day mode
    backend.lux = 20.0
    ctrl.poll_once()
    clock.advance(6.0)
    ctrl.poll_once()
    assert not ctrl.state.enabled
    assert backend.backlight_percent == 70


def test_night_mode_pauses_while_video_plays_and_engages_after() -> None:
    clock = FakeClock()
    backend = MockAmbientBackend(initial_lux=2.0)
    cfg = NightModeConfig(enter_debounce_seconds=5.0, pause_during_video=True)
    ctrl = AmbientNightModeController(backend, cfg, clock=clock)

    ctrl.set_video_active(True)
    ctrl.poll_once()
    clock.advance(6.0)
    ctrl.poll_once()
    assert not ctrl.state.enabled
    assert ctrl.state.paused_for_video

    # Returning Home engages Night Mode immediately since lux is already dark
    ctrl.set_video_active(False)
    assert ctrl.state.enabled
    assert not ctrl.state.paused_for_video


def test_linux_ambient_backend_sysfs_read_write(tmp_path: Path) -> None:
    iio = tmp_path / "iio" / "iio:device0"
    iio.mkdir(parents=True)
    (iio / "in_illuminance_raw").write_text("12", encoding="utf-8")
    (iio / "in_illuminance_scale").write_text("0.5", encoding="utf-8")

    bl = tmp_path / "backlight" / "intel_backlight"
    bl.mkdir(parents=True)
    (bl / "max_brightness").write_text("1000", encoding="utf-8")
    (bl / "brightness").write_text("600", encoding="utf-8")

    backend = LinuxAmbientBackend(iio_root=tmp_path / "iio", backlight_root=tmp_path / "backlight")
    assert backend.read_lux() == 6.0
    backend.set_backlight_percent(3)
    assert (bl / "brightness").read_text(encoding="utf-8") == "30"


def test_audio_service_rocker_and_independent_channels() -> None:
    backend = MockAudioBackend(
        AudioDefaultsConfig(alarm_sink_percent=100, tts_sink_percent=50, media_sink_percent=60)
    )
    svc = AudioService(backend, step_percent=5)

    state = svc.handle_rocker("up")
    assert state.media_percent == 65
    assert state.alarm_percent == 100
    assert state.tts_percent == 50

    state = svc.handle_rocker("mute")
    assert state.media_muted is True

    state = svc.handle_rocker("up")
    assert state.media_muted is False
    assert state.media_percent == 70



def test_pipewire_audio_backend_pactl_commands_parsing_and_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []
    sink_outputs: dict[tuple[str, str], str] = {
        ("get-sink-volume", "alarm-sink"): "Volume: front-left: 65536 / 100% / 0.00 dB",
        ("get-sink-mute", "alarm-sink"): "Mute: no\n",
        ("get-sink-volume", "tts-sink"): "Volume: front-left: 32768 /  50% / -18.06 dB",
        ("get-sink-mute", "tts-sink"): "Mute: no\n",
        ("get-sink-volume", "media-sink"): "Volume: front-left: 42598 /  65% / -11.23 dB",
        ("get-sink-mute", "media-sink"): "Mute: yes\n",
    }

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        action, sink = cmd[1], cmd[2]
        if action == "set-sink-volume":
            pct = cmd[3]
            sink_outputs[("get-sink-volume", sink)] = f"Volume: front-left: 0 / {pct} / 0 dB"
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if action == "set-sink-mute":
            muted = "yes" if cmd[3] == "1" else "no"
            sink_outputs[("get-sink-mute", sink)] = f"Mute: {muted}\n"
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        stdout = sink_outputs[(action, sink)]
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    defaults = AudioDefaultsConfig(
        alarm_sink_percent=95,
        tts_sink_percent=40,
        media_sink_percent=55,
    )
    backend = PipeWireAudioBackend(defaults=defaults)

    initial = backend.get_state()
    assert initial.alarm_percent == 100 and initial.alarm_muted is False
    assert initial.tts_percent == 50 and initial.tts_muted is False
    assert initial.media_percent == 65 and initial.media_muted is True

    # set_level clamps to [0, 150] and invokes set-sink-volume + set-sink-mute
    updated = backend.set_level("alarm", percent=180, muted=True)
    assert ["pactl", "set-sink-volume", "alarm-sink", "150%"] in calls
    assert ["pactl", "set-sink-mute", "alarm-sink", "1"] in calls
    assert updated.alarm_percent == 150
    assert updated.alarm_muted is True

    updated_media = backend.set_level("media", percent=75, muted=False)
    assert ["pactl", "set-sink-volume", "media-sink", "75%"] in calls
    assert ["pactl", "set-sink-mute", "media-sink", "0"] in calls
    assert updated_media.media_percent == 75
    assert updated_media.media_muted is False

    # Missing pactl falls back cleanly to local MockAudioBackend values without raising
    def missing_pactl(*args: Any, **kwargs: Any) -> Any:
        raise FileNotFoundError("pactl not installed")

    monkeypatch.setattr(subprocess, "run", missing_pactl)
    fallback_state = backend.set_level("tts", percent=82, muted=True)
    assert fallback_state.tts_percent == 82
    assert fallback_state.tts_muted is False  # get-sink-mute unavailable -> False default
    assert fallback_state.alarm_percent == 150
    assert fallback_state.media_percent == 75
