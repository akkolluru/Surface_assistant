import { useEffect, useState } from "react";
import { Cloud, Image as ImageIcon, Moon, Sun, Timer, Volume2 } from "lucide-react";
import type { DaemonStateSnapshot } from "../types/hub";
import { DevicePill } from "./DevicePill";

interface AmbientHubPaneProps {
  state: DaemonStateSnapshot;
  onNextWallpaper: () => void;
  onSetSleepTimer: (minutes: number) => void;
  onToggleNightMode: (enabled: boolean | null) => void;
  onOpenVolume: () => void;
  onNavigatePane: (index: 0 | 1 | 2) => void;
}

const SLEEP_OPTIONS = [15, 30, 45, 60, 0] as const;

function formatClock(now: Date, clockFormat: "12h" | "24h"): { time: string; period: string } {
  const hours24 = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  if (clockFormat === "24h") {
    return { time: `${String(hours24).padStart(2, "0")}:${minutes}`, period: "" };
  }
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return { time: `${hours12}:${minutes}`, period };
}

function formatDate(now: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);
}

function formatRemaining(seconds: number): string {
  const mins = Math.ceil(seconds / 60);
  return `${mins}m`;
}

export function AmbientHubPane({
  state,
  onNextWallpaper,
  onSetSleepTimer,
  onToggleNightMode,
  onOpenVolume,
  onNavigatePane,
}: AmbientHubPaneProps) {
  const [now, setNow] = useState<Date>(() => new Date());
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  const [nightPeek, setNightPeek] = useState(false);
  const [nightPeekTick, setNightPeekTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state.night_mode.enabled) {
      setNightPeek(false);
      setSleepMenuOpen(false);
      return;
    }
    if (!nightPeek) {
      setSleepMenuOpen(false);
      return;
    }
    const timer = window.setTimeout(() => setNightPeek(false), 8000);
    return () => window.clearTimeout(timer);
  }, [state.night_mode.enabled, nightPeek, nightPeekTick]);

  useEffect(() => {
    if (!sleepMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSleepMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sleepMenuOpen]);

  const bumpNightPeek = () => {
    if (state.night_mode.enabled && nightPeek) {
      setNightPeekTick((n) => n + 1);
    }
  };

  const activeWallpaper = state.wallpapers.items[state.wallpapers.current_index];
  const { time, period } = formatClock(now, state.clock_format);
  const dateLabel = formatDate(now);
  const sleepSeconds = state.media.sleep_timer_remaining_seconds;
  const isNight = state.night_mode.enabled;

  const tempDisplay = state.weather
    ? state.temperature_unit === "F"
      ? `${Math.round((state.weather.temperature_c * 9) / 5 + 32)}°F`
      : `${Math.round(state.weather.temperature_c)}°C`
    : null;

  return (
    <section
      aria-label="Ambient Hub"
      onClick={() => {
        if (sleepMenuOpen) {
          setSleepMenuOpen(false);
        }
        if (isNight) setNightPeek((prev) => !prev);
      }}
      className="pane-item pane-no-scroll relative flex h-full w-full flex-col justify-between overflow-hidden bg-black p-8 md:p-10"
    >
      {/* Background Art / Looping MP4 Canvas (hidden in Night Mode) */}
      {!isNight && activeWallpaper && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-opacity duration-700"
        >
          {activeWallpaper.kind === "video" ? (
            <video
              key={activeWallpaper.id}
              src={activeWallpaper.url}
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover"
            />
          ) : (
            <img
              key={activeWallpaper.id}
              src={activeWallpaper.url}
              alt=""
              className="h-full w-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-black/35" />
        </div>
      )}

      {/* Top Row: Subtle Pane Navigation Hints (hidden in Night Mode unless peeked) */}
      <div
        className={`relative z-10 flex items-center justify-between transition-opacity duration-500 ${
          isNight && !nightPeek ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigatePane(0);
          }}
          className="glass-panel touch-target rounded-full px-4 py-1.5 text-xs font-medium text-white/75 hover:bg-white/15"
        >
          ← Controls
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigatePane(2);
          }}
          className="glass-panel touch-target rounded-full px-4 py-1.5 text-xs font-medium text-white/75 hover:bg-white/15"
        >
          Media →
        </button>
      </div>

      {/* Bottom / Primary Display Row */}
      <div className="relative z-10 mt-auto flex flex-col justify-between gap-6 md:flex-row md:items-end">
        {/* Clock, Date & Weather */}
        <div
          className={
            isNight
              ? "text-[var(--night-amber)] transition-colors duration-700"
              : "text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.65)] transition-colors duration-700"
          }
        >
          <div className="flex items-baseline gap-3">
            <time
              className={`font-light tracking-tight tabular-nums ${
                isNight ? "text-7xl opacity-55 md:text-8xl" : "text-7xl md:text-8xl"
              }`}
            >
              {time}
            </time>
            {period && (
              <span className={`text-2xl font-medium ${isNight ? "opacity-45" : "text-white/80"}`}>
                {period}
              </span>
            )}
          </div>

          <div className={`mt-1.5 flex flex-wrap items-center gap-3 ${isNight ? "opacity-45" : "text-white/85"}`}>
            <span className="text-lg font-medium">{dateLabel}</span>
            {!isNight && tempDisplay && state.weather && (
              <span className="flex items-center gap-1.5 text-lg font-medium text-white/90">
                <Cloud className="h-4 w-4 text-sky-300" aria-hidden="true" />
                {tempDisplay} · {state.weather.condition_label}
              </span>
            )}
            {sleepSeconds !== null && sleepSeconds > 0 && (
              <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-semibold tabular-nums">
                Sleep in {formatRemaining(sleepSeconds)}
              </span>
            )}
          </div>
        </div>

        {/* Lower-Right Controls (reachable from left-of-bed placement) */}
        <div
          onPointerDown={bumpNightPeek}
          onClick={(e) => {
            e.stopPropagation();
            bumpNightPeek();
          }}
          className={`flex flex-col items-end gap-3 transition-opacity duration-300 ${
            isNight && !nightPeek ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          {!isNight && <DevicePill devices={state.devices} />}

          <div className="relative flex flex-wrap items-center justify-end gap-2.5">
            {sleepMenuOpen && (
              <div
                role="menu"
                aria-label="Sleep timer presets"
                className="glass-panel absolute right-0 bottom-14 flex items-center gap-1.5 rounded-full p-1.5 shadow-2xl"
              >
                {SLEEP_OPTIONS.map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSetSleepTimer(mins);
                      setSleepMenuOpen(false);
                    }}
                    className="touch-target rounded-full px-3.5 py-1.5 text-xs font-semibold text-white/90 hover:bg-white/15"
                  >
                    {mins === 0 ? "Off" : `${mins}m`}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              aria-label="Sleep timer"
              aria-expanded={sleepMenuOpen}
              onClick={() => setSleepMenuOpen((prev) => !prev)}
              className="glass-panel touch-target flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold text-white/90 hover:bg-white/15"
            >
              <Timer className="h-4 w-4 text-sky-300" aria-hidden="true" />
              <span>{sleepSeconds ? formatRemaining(sleepSeconds) : "Sleep"}</span>
            </button>

            {!isNight && (
              <button
                type="button"
                aria-label="Next wallpaper"
                onClick={onNextWallpaper}
                className="glass-panel touch-target flex items-center justify-center rounded-full p-2.5 text-white/90 hover:bg-white/15"
              >
                <ImageIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              aria-label="Open audio mixer"
              onClick={onOpenVolume}
              className="glass-panel touch-target flex items-center justify-center rounded-full p-2.5 text-white/90 hover:bg-white/15"
            >
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              aria-label={isNight ? "Disable night mode" : "Enable night mode"}
              aria-pressed={isNight}
              onClick={() => onToggleNightMode(isNight ? false : true)}
              className="glass-panel touch-target flex items-center justify-center rounded-full p-2.5 text-white/90 hover:bg-white/15"
            >
              {isNight ? (
                <Sun className="h-4 w-4 text-amber-300" aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
