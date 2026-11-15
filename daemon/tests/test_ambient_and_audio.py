"""Tests for Smart Night Mode controller and PipeWire modular AudioService."""

from __future__ import annotations

from pathlib import Path

from daemon.ambient_light import (
    AmbientNightModeController,
    LinuxAmbientBackend,
    MockAmbientBackend,
)
from daemon.audio_control import AudioService, MockAudioBackend
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
