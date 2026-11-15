import { useEffect } from "react";
import { AlarmClock, MessageSquareQuote, Music, Volume2, VolumeX, X } from "lucide-react";
import type { AudioChannel, AudioState } from "../types/hub";

interface VolumeOSDProps {
  open: boolean;
  audio: AudioState;
  onClose: () => void;
  onChangeLevel: (channel: AudioChannel, payload: { percent?: number; muted?: boolean }) => void;
}

interface ChannelRow {
  channel: AudioChannel;
  label: string;
  subtitle: string;
  percent: number;
  muted: boolean;
  max: number;
  Icon: typeof Music;
}

export function VolumeOSD({ open, audio, onClose, onChangeLevel }: VolumeOSDProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows: ChannelRow[] = [
    {
      channel: "media",
      label: "Media Playback",
      subtitle: "YouTube · Netflix · Stremio",
      percent: audio.media_percent,
      muted: audio.media_muted,
      max: 100,
      Icon: Music,
    },
    {
      channel: "tts",
      label: "Voice Assistant",
      subtitle: "Piper TTS responses",
      percent: audio.tts_percent,
      muted: audio.tts_muted,
      max: 100,
      Icon: MessageSquareQuote,
    },
    {
      channel: "alarm",
      label: "Alarms & Timers",
      subtitle: "Independent wake stream",
      percent: audio.alarm_percent,
      muted: audio.alarm_muted,
      max: 100,
      Icon: AlarmClock,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="volume-osd-title"
        onClick={(e) => e.stopPropagation()}
        className="glass-panel w-full max-w-md rounded-3xl p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Volume2 className="h-5 w-5 text-sky-300" aria-hidden="true" />
            <h2 id="volume-osd-title" className="text-lg font-semibold text-white">
              Modular Audio Mixer
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close audio mixer"
            onClick={onClose}
            className="touch-target flex items-center justify-center rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-5">
          {rows.map(({ channel, label, subtitle, percent, muted, max, Icon }) => (
            <div key={channel} className="rounded-2xl bg-white/5 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 text-sky-300" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-white">{label}</p>
                    <p className="text-xs text-white/50">{subtitle}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-11 text-right text-sm font-semibold tabular-nums text-white/90">
                    {muted ? "Mute" : `${percent}%`}
                  </span>
                  <button
                    type="button"
                    aria-label={`${muted ? "Unmute" : "Mute"} ${label}`}
                    aria-pressed={muted}
                    onClick={() => onChangeLevel(channel, { muted: !muted })}
                    className="touch-target flex items-center justify-center rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20"
                  >
                    {muted ? (
                      <VolumeX className="h-4 w-4 text-rose-300" aria-hidden="true" />
                    ) : (
                      <Volume2 className="h-4 w-4 text-white/80" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
              <label className="block">
                <span className="sr-only">{label} volume</span>
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={percent}
                  onChange={(e) =>
                    onChangeLevel(channel, { percent: Number(e.target.value), muted: false })
                  }
                  className="h-2 w-full cursor-pointer accent-sky-400"
                />
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
