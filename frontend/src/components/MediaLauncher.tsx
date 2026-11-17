import { ChevronLeft, Clapperboard, Film, Play, Sparkles, Tv } from "lucide-react";
import type { MediaTileConfig } from "../types/hub";

interface MediaLauncherProps {
  tiles: MediaTileConfig[];
  activeTileId: string | null;
  onLaunchTile: (tileId: string) => void;
  onNavigateHub: () => void;
}

const TILE_ACCENTS: Record<string, { gradient: string; Icon: typeof Tv; subtitle: string }> = {
  youtube: {
    gradient: "from-rose-600/35 via-red-900/25 to-zinc-900/70 border-rose-400/25",
    Icon: Play,
    subtitle: "YouTube Premium",
  },
  netflix: {
    gradient: "from-red-700/40 via-rose-950/30 to-zinc-900/70 border-red-500/25",
    Icon: Film,
    subtitle: "Widevine HD",
  },
  prime: {
    gradient: "from-sky-600/35 via-blue-950/30 to-zinc-900/70 border-sky-400/25",
    Icon: Tv,
    subtitle: "Prime Video",
  },
  anime: {
    gradient: "from-violet-600/35 via-purple-950/30 to-zinc-900/70 border-violet-400/25",
    Icon: Sparkles,
    subtitle: "Ad-Free Stream",
  },
  stremio: {
    gradient: "from-indigo-600/35 via-slate-900/35 to-zinc-900/70 border-indigo-400/25",
    Icon: Clapperboard,
    subtitle: "Native VA-API Client",
  },
};

export function MediaLauncher({
  tiles,
  activeTileId,
  onLaunchTile,
  onNavigateHub,
}: MediaLauncherProps) {
  return (
    <section
      aria-label="Bedside Video Launcher"
      className="pane-item flex h-full w-full flex-col justify-between bg-gradient-to-bl from-zinc-950 via-slate-950 to-black px-8 pt-8 pb-11 md:px-10"
    >
      {/* Upper ambient marquee (display-only; all interactive controls sit in the lower deck) */}
      <header className="pointer-events-none flex items-start justify-end">
        <div className="text-right">
          <h2 className="text-3xl font-semibold tracking-tight text-white">Bedside Theater</h2>
          <p className="mt-1 text-sm text-white/55">Single-window VA-API playback</p>
        </div>
      </header>

      {/* Bottom-aligned interactive launcher deck (y >= 650px on 1563x1042) */}
      <div className="mt-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onNavigateHub}
            className="glass-panel touch-target flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium text-white/90 hover:bg-white/15"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span>Hub</span>
          </button>
          <span className="text-xs text-white/45">
            Swipe right or tap Hub to return to Ambient Hub
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
          {tiles.map((tile) => {
            const style = TILE_ACCENTS[tile.id] ?? {
              gradient: "from-slate-700/35 to-zinc-900/70 border-white/15",
              Icon: Tv,
              subtitle: tile.kind === "native_app" ? "Desktop App" : "Web App",
            };
            const Icon = style.Icon;
            const isRunning = activeTileId === tile.id;

            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => onLaunchTile(tile.id)}
                className={`touch-target group relative flex min-h-40 flex-col justify-between rounded-3xl border bg-gradient-to-br p-5 text-left backdrop-blur-xl transition hover:brightness-110 active:brightness-110 ${style.gradient}`}
              >
                <div className="flex items-center justify-between">
                  <div className="rounded-2xl bg-white/10 p-3">
                    <Icon className="h-6 w-6 text-white" aria-hidden="true" />
                  </div>
                  {isRunning && (
                    <span className="rounded-full bg-emerald-400/20 px-3 py-1 text-xs font-semibold text-emerald-300">
                      Resume
                    </span>
                  )}
                </div>
                <div>
                  <p className="text-lg font-semibold text-white">{tile.label}</p>
                  <p className="mt-0.5 text-xs text-white/60">{style.subtitle}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
