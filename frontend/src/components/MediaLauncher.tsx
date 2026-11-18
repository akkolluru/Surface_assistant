import { useEffect, useState } from "react";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Clock,
  Film,
  Moon,
  Play,
  Sparkles,
  Tv,
} from "lucide-react";
import type { MediaTileConfig } from "../types/hub";

interface MediaLauncherProps {
  tiles: MediaTileConfig[];
  activeTileId: string | null;
  onLaunchTile: (tileId: string) => void;
  onNavigateHub: () => void;
}

interface CuratedPick {
  title: string;
  category: string;
  duration: string;
  note: string;
  progressPct: number;
}

interface TileStageMetadata {
  channelLabel: string;
  categoryTag: string;
  gradient: string;
  spotlightRing: string;
  stageCardBg: string;
  ambientGlow: string;
  accentBadge: string;
  accentBar: string;
  ctaStyle: string;
  Icon: typeof Tv;
  subtitle: string;
  cardSummary: string;
  tagline: string;
  description: string;
  specs: string[];
  audioProfile: string;
  spectrumHeights: number[];
  picks: CuratedPick[];
}

const TILE_STAGE_CATALOG: Record<string, TileStageMetadata> = {
  youtube: {
    channelLabel: "Channel 01",
    categoryTag: "4K Ambient & Creators",
    gradient:
      "from-rose-600/35 via-red-950/40 to-zinc-950/90 border-rose-400/30 hover:border-rose-300/60",
    spotlightRing: "ring-2 ring-rose-400/75 shadow-[0_0_35px_-5px_rgba(244,63,94,0.35)]",
    stageCardBg: "from-rose-950/60 via-zinc-950/85 to-black/90 border-rose-400/30",
    ambientGlow:
      "radial-gradient(circle at 24% 26%, rgba(244, 63, 94, 0.30), rgba(15, 23, 42, 0) 64%)",
    accentBadge: "bg-rose-500/20 text-rose-200 border-rose-400/35",
    accentBar: "from-rose-400 to-red-600",
    ctaStyle: "border-rose-400/40 bg-rose-500/25 text-rose-100 hover:bg-rose-500/35",
    Icon: Play,
    subtitle: "YouTube Premium",
    cardSummary: "Late-night video essays, acoustic sessions & 4K ambient horizons.",
    tagline: "Late-Night Creator Cinema & 4K Ambient Horizons",
    description:
      "Ad-free late-night essays, live orbital views, and acoustic sessions with gentle midnight loudness balancing and deep-black OLED contrast.",
    specs: [
      "4K HDR Cinema",
      "Whisper Loudness",
      "Ad-Free Viewing",
      "Sleep Timer Ready",
    ],
    audioProfile: "Midnight Whisper Curve · Balanced",
    spectrumHeights: [42, 68, 86, 58, 92, 74, 48, 72, 96, 64, 46, 80, 88, 56, 70, 44],
    picks: [
      {
        category: "Ambient 4K",
        title: "Earth Night Orbit · Cupola Window",
        duration: "Live · 60fps",
        note: "Zero-glare dark horizon stream for winding down",
        progressPct: 72,
      },
      {
        category: "Cinema Essay",
        title: "The Architecture of Quiet Spaces",
        duration: "42 min left",
        note: "Warm narration with acoustic room tone",
        progressPct: 38,
      },
      {
        category: "Late Session",
        title: "Midnight Analog Tape & Rain",
        duration: "1 hr 15m",
        note: "Soft low-pass filter for bedside comfort",
        progressPct: 85,
      },
    ],
  },
  netflix: {
    channelLabel: "Channel 02",
    categoryTag: "Prestige Series & Film",
    gradient:
      "from-red-700/40 via-rose-950/40 to-zinc-950/90 border-red-500/30 hover:border-red-400/60",
    spotlightRing: "ring-2 ring-red-400/75 shadow-[0_0_35px_-5px_rgba(239,68,68,0.35)]",
    stageCardBg: "from-red-950/65 via-zinc-950/85 to-black/90 border-red-500/30",
    ambientGlow:
      "radial-gradient(circle at 24% 26%, rgba(220, 38, 38, 0.32), rgba(15, 23, 42, 0) 64%)",
    accentBadge: "bg-red-500/20 text-red-200 border-red-400/35",
    accentBar: "from-red-400 to-rose-700",
    ctaStyle: "border-red-400/40 bg-red-500/25 text-red-100 hover:bg-red-500/35",
    Icon: Film,
    subtitle: "Cinema Originals",
    cardSummary: "Prestige dramas, Studio Ghibli classics & instant episode resume.",
    tagline: "Original Feature Films & Prestige Limited Series",
    description:
      "Calibrated shadow detail for dark-room viewing, vocal clarity boost for quiet bedside listening, and seamless episode continuation.",
    specs: [
      "Night-Calibrated Contrast",
      "Whisper Dialog Boost",
      "Auto-Skip Intro",
      "Instant Episode Resume",
    ],
    audioProfile: "Cinema Dialog Clarity · Night",
    spectrumHeights: [54, 80, 96, 70, 50, 86, 94, 64, 76, 90, 58, 46, 78, 92, 60, 48],
    picks: [
      {
        category: "Sci-Fi Drama",
        title: "Dark Matter · Season Finale",
        duration: "24 min left",
        note: "Continue from Chapter 4 with night audio",
        progressPct: 64,
      },
      {
        category: "Studio Ghibli",
        title: "The Boy and the Heron",
        duration: "2 hr 04m",
        note: "Hand-painted feature with warm evening palette",
        progressPct: 18,
      },
      {
        category: "Nature Cinema",
        title: "Our Planet: Midnight Oceans",
        duration: "50 min",
        note: "Deep-sea bioluminescence in cinema dark grade",
        progressPct: 90,
      },
    ],
  },
  prime: {
    channelLabel: "Channel 03",
    categoryTag: "UHD Originals & X-Ray",
    gradient:
      "from-sky-600/35 via-blue-950/40 to-zinc-950/90 border-sky-400/30 hover:border-sky-300/60",
    spotlightRing: "ring-2 ring-sky-400/75 shadow-[0_0_35px_-5px_rgba(56,189,248,0.35)]",
    stageCardBg: "from-sky-950/60 via-slate-950/85 to-black/90 border-sky-400/30",
    ambientGlow:
      "radial-gradient(circle at 24% 26%, rgba(14, 165, 233, 0.30), rgba(15, 23, 42, 0) 64%)",
    accentBadge: "bg-sky-500/20 text-sky-200 border-sky-400/35",
    accentBar: "from-sky-400 to-blue-600",
    ctaStyle: "border-sky-400/40 bg-sky-500/25 text-sky-100 hover:bg-sky-500/35",
    Icon: Tv,
    subtitle: "Prime Video",
    cardSummary: "Award-winning originals, X-Ray scene notes & theater rentals.",
    tagline: "UHD Originals, X-Ray Scene Insights & Cinema Rentals",
    description:
      "True 24fps film cadence with interactive X-Ray cast notes and enhanced center-channel voice presence for effortless late-night viewing.",
    specs: [
      "24fps Film Cadence",
      "X-Ray Scene Notes",
      "Dialog Clarity Plus",
      "Curated Watchlist",
    ],
    audioProfile: "Center Voice Presence · Warm",
    spectrumHeights: [46, 64, 76, 90, 68, 52, 84, 96, 72, 60, 78, 66, 50, 82, 70, 44],
    picks: [
      {
        category: "Prime Original",
        title: "Fallout · Wasteland Dispatch",
        duration: "31 min left",
        note: "X-Ray soundtrack & scene trivia enabled",
        progressPct: 52,
      },
      {
        category: "Space Opera",
        title: "The Expanse · Ring Station",
        duration: "47 min",
        note: "High-contrast starfield grade for dark rooms",
        progressPct: 80,
      },
      {
        category: "Theater Rental",
        title: "Dune: Part Two · IMAX Edition",
        duration: "2 hr 46m",
        note: "Sub-bass tamed for peaceful midnight viewing",
        progressPct: 25,
      },
    ],
  },
  anime: {
    channelLabel: "Channel 04",
    categoryTag: "Simulcasts & Seinen",
    gradient:
      "from-violet-600/35 via-purple-950/40 to-zinc-950/90 border-violet-400/30 hover:border-violet-300/60",
    spotlightRing: "ring-2 ring-violet-400/75 shadow-[0_0_35px_-5px_rgba(167,139,250,0.35)]",
    stageCardBg: "from-violet-950/60 via-zinc-950/85 to-black/90 border-violet-400/30",
    ambientGlow:
      "radial-gradient(circle at 24% 26%, rgba(139, 92, 246, 0.32), rgba(15, 23, 42, 0) 64%)",
    accentBadge: "bg-violet-500/20 text-violet-200 border-violet-400/35",
    accentBar: "from-violet-400 to-fuchsia-600",
    ctaStyle: "border-violet-400/40 bg-violet-500/25 text-violet-100 hover:bg-violet-500/35",
    Icon: Sparkles,
    subtitle: "Ad-Free Simulcast",
    cardSummary: "Seasonal premieres, cozy slice-of-life & late-night seinen classics.",
    tagline: "Seasonal Simulcasts & Late-Night Seinen Sanctuary",
    description:
      "Crisp hand-drawn line art with soft-glow subtitle typography, zero commercial interruptions, and automatic opening/ending chapter markers.",
    specs: [
      "Simulcast Premieres",
      "Soft-Glow Subtitles",
      "Chapter Auto-Skip",
      "Original Japanese Audio",
    ],
    audioProfile: "Studio 2.0 Master · Gentle Highs",
    spectrumHeights: [62, 88, 72, 96, 80, 56, 90, 66, 94, 82, 52, 76, 92, 68, 84, 58],
    picks: [
      {
        category: "Fantasy Journey",
        title: "Frieren: Beyond Journey's End",
        duration: "24 min · Ep 28",
        note: "Orchestral score with warm twilight color palette",
        progressPct: 68,
      },
      {
        category: "Cozy Night",
        title: "Laid-Back Camp · Starry Lake",
        duration: "23 min · Sub",
        note: "Relaxing acoustic guitar & campfire ambiance",
        progressPct: 92,
      },
      {
        category: "Cyberpunk Noir",
        title: "Ghost in the Shell · Stand Alone",
        duration: "25 min · Remaster",
        note: "Classic nocturnal sci-fi in pristine clarity",
        progressPct: 40,
      },
    ],
  },
  stremio: {
    channelLabel: "Channel 05",
    categoryTag: "Personal Cinema Vault",
    gradient:
      "from-indigo-600/35 via-slate-900/45 to-zinc-950/90 border-indigo-400/30 hover:border-indigo-300/60",
    spotlightRing: "ring-2 ring-indigo-400/75 shadow-[0_0_35px_-5px_rgba(129,140,248,0.35)]",
    stageCardBg: "from-indigo-950/60 via-slate-950/85 to-black/90 border-indigo-400/30",
    ambientGlow:
      "radial-gradient(circle at 24% 26%, rgba(99, 102, 241, 0.32), rgba(15, 23, 42, 0) 64%)",
    accentBadge: "bg-indigo-500/20 text-indigo-200 border-indigo-400/35",
    accentBar: "from-indigo-400 to-cyan-500",
    ctaStyle: "border-indigo-400/40 bg-indigo-500/25 text-indigo-100 hover:bg-indigo-500/35",
    Icon: Clapperboard,
    subtitle: "Personal Cinema Hub",
    cardSummary: "Curated home library, festival restorations & synced watchlists.",
    tagline: "Personal Cinema Vault & Curated World Film Library",
    description:
      "Instant access to your personal film collection and cloud watchlist with synchronized subtitles, chapter timelines, and bedside comfort presets.",
    specs: [
      "4K Mastered Streams",
      "Synced Watchlist",
      "Custom Subtitle Timing",
      "Instant Scene Resume",
    ],
    audioProfile: "Direct Studio Warmth · Night",
    spectrumHeights: [50, 74, 86, 62, 94, 78, 58, 90, 96, 70, 54, 82, 76, 64, 88, 52],
    picks: [
      {
        category: "Neo-Noir",
        title: "Blade Runner 2049 · Director's Cut",
        duration: "1 hr 12m left",
        note: "Vangelis-inspired synth score in night comfort mode",
        progressPct: 58,
      },
      {
        category: "Criterion Vault",
        title: "In the Mood for Love · 4K Restoration",
        duration: "1 hr 38m",
        note: "Lush crimson & amber cinematography",
        progressPct: 30,
      },
      {
        category: "Watchlist Sync",
        title: "Severance · Late-Night Rewatch",
        duration: "49 min · Ep 09",
        note: "Bookmarked scene ready for instant playback",
        progressPct: 84,
      },
    ],
  },
};

const FALLBACK_STAGE: TileStageMetadata = {
  channelLabel: "Channel",
  categoryTag: "Featured Stream",
  gradient: "from-slate-700/35 to-zinc-900/85 border-white/15",
  spotlightRing: "ring-2 ring-white/50",
  stageCardBg: "from-slate-900/65 via-zinc-950/85 to-black/90 border-white/15",
  ambientGlow:
    "radial-gradient(circle at 24% 26%, rgba(148, 163, 184, 0.24), rgba(15, 23, 42, 0) 64%)",
  accentBadge: "bg-white/10 text-white/85 border-white/20",
  accentBar: "from-slate-300 to-slate-500",
  ctaStyle: "border-white/25 bg-white/15 text-white hover:bg-white/25",
  Icon: Tv,
  subtitle: "Bedside Stream",
  cardSummary: "Full-screen bedside cinema with night-calibrated audio and visuals.",
  tagline: "Relaxed Late-Night Viewing & Comfort Audio",
  description:
    "Dedicated bedside theater experience with gentle eye-care contrast and automatic sleep-timer protection.",
  specs: ["Night-Calibrated Contrast", "Whisper Audio", "Instant Resume", "Sleep Guard"],
  audioProfile: "Midnight Whisper Curve",
  spectrumHeights: [45, 65, 80, 55, 75, 60, 85, 70, 50, 65, 75, 60, 80, 55, 65, 45],
  picks: [
    {
      category: "Tonight",
      title: "Curated Evening Feature",
      duration: "Ready",
      note: "Prepared for instant bedside viewing",
      progressPct: 60,
    },
    {
      category: "Comfort",
      title: "Midnight Acoustic Session",
      duration: "45 min",
      note: "Warm low-volume soundstage",
      progressPct: 40,
    },
    {
      category: "Relax",
      title: "Ambient Horizon Cinema",
      duration: "1 hr",
      note: "Deep-black contrast for dark rooms",
      progressPct: 75,
    },
  ],
};

function formatBedsideTime(now: Date): { time: string; period: string; eveningLabel: string } {
  const hours24 = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  const eveningLabel =
    hours24 >= 21 || hours24 < 5
      ? "Late-Night Sanctuary"
      : hours24 >= 17
        ? "Evening Cinema"
        : "Daylight Lounge";
  return { time: `${hours12}:${minutes}`, period, eveningLabel };
}

export function MediaLauncher({
  tiles,
  activeTileId,
  onLaunchTile,
  onNavigateHub,
}: MediaLauncherProps) {
  const [spotlightId, setSpotlightId] = useState<string>(
    () => activeTileId ?? tiles[0]?.id ?? "youtube"
  );
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    if (activeTileId) {
      setSpotlightId(activeTileId);
    }
  }, [activeTileId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(id);
  }, []);

  const spotlightTile =
    tiles.find((t) => t.id === spotlightId) ??
    tiles.find((t) => t.id === activeTileId) ??
    tiles[0] ?? {
      id: "youtube",
      label: "YouTube",
      kind: "browser_app" as const,
      target: "https://www.youtube.com",
    };

  const activeTile = tiles.find((t) => t.id === activeTileId) ?? null;
  const stageMeta = TILE_STAGE_CATALOG[spotlightTile.id] ?? FALLBACK_STAGE;
  const StageIcon = stageMeta.Icon;
  const isSpotlightRunning = activeTileId === spotlightTile.id;
  const { time, period, eveningLabel } = formatBedsideTime(now);

  const cycleSpotlight = (delta: number) => {
    if (tiles.length === 0) return;
    const currentIndex = Math.max(
      0,
      tiles.findIndex((t) => t.id === spotlightTile.id)
    );
    const nextIndex = (currentIndex + delta + tiles.length) % tiles.length;
    const nextTile = tiles[nextIndex];
    if (nextTile) {
      setSpotlightId(nextTile.id);
    }
  };

  return (
    <section
      aria-label="Bedside Video Launcher"
      className="pane-item relative flex h-full w-full flex-col justify-between overflow-hidden bg-gradient-to-bl from-zinc-950 via-slate-950 to-black px-8 pt-6 pb-14 md:px-10"
    >
      {/* Dynamic Service-Tinted Ambient Backdrop (100% non-interactive) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-all duration-700"
        style={{ background: stageMeta.ambientGlow }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.05),transparent_68%)]"
      />

      {/* =====================================================================
          UPPER HALF: BEDSIDE CINEMA STAGE (y = 24..580px, h-[556px], pointer-events-none)
          Fills the upper canvas richly while staying strictly above y = 595px.
         ===================================================================== */}
      <div className="pointer-events-none relative z-10 flex h-[556px] shrink-0 flex-col gap-4">
        {/* Top Stage Header Bar */}
        <header className="flex shrink-0 items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/5 shadow-inner">
              <Moon className="h-5 w-5 text-amber-300/90" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold tracking-[0.18em] text-white/55 uppercase">
                  {eveningLabel} · Night-Calibrated Display
                </span>
                <span className="h-1 w-1 rounded-full bg-white/30" />
                <span className="text-[11px] font-medium text-amber-200/90">
                  Eye-Care Warmth Active
                </span>
              </div>
              <h2 className="text-3xl font-semibold tracking-tight text-white [text-wrap:balance]">
                Bedside Theater
              </h2>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5 text-right">
            <div className="flex items-center gap-2.5">
              <span className="rounded-full border border-white/10 bg-white/5 px-3.5 py-1 text-xs font-medium text-white/80">
                Whisper-Balanced Bedside Audio
              </span>
              <span
                className={`flex items-center gap-2 rounded-full border px-3.5 py-1 text-xs font-semibold ${
                  activeTile
                    ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                    : "border-white/15 bg-white/5 text-white/80"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    activeTile ? "animate-pulse bg-emerald-400" : "bg-sky-300"
                  }`}
                />
                {activeTile
                  ? `Now Playing · ${activeTile.label}`
                  : `On Stage · ${spotlightTile.label}`}
              </span>
            </div>
            <p className="text-xs text-white/50">
              Curated late-night cinema · Automatic sleep-timer protection
            </p>
          </div>
        </header>

        {/* 12-Column Cinema Marquee & Comfort Stage (Stretches to y = 580px) */}
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-5">
          {/* Left 8 Columns: Spotlight Service Hero Card */}
          <article
            className={`col-span-8 flex h-full flex-col justify-between rounded-3xl border bg-gradient-to-br p-6 shadow-2xl backdrop-blur-2xl transition-all duration-500 ${stageMeta.stageCardBg}`}
          >
            {/* Hero Top Metadata Row */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/10 shadow-lg">
                  <StageIcon className="h-8 w-8 text-white" aria-hidden="true" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-3 py-0.5 text-[11px] font-semibold tracking-wider uppercase ${stageMeta.accentBadge}`}
                    >
                      {stageMeta.channelLabel} · On Stage
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-0.5 text-[11px] font-medium text-white/75">
                      {stageMeta.categoryTag}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-3">
                    <h3 className="text-3xl font-bold tracking-tight text-white">
                      {spotlightTile.label}
                    </h3>
                    <span className="text-sm font-medium text-white/60">
                      {stageMeta.subtitle}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1.5">
                <span
                  className={`rounded-full border px-3.5 py-1 text-xs font-semibold ${
                    isSpotlightRunning
                      ? "border-emerald-400/40 bg-emerald-400/20 text-emerald-200"
                      : "border-white/15 bg-white/10 text-white/85"
                  }`}
                >
                  {isSpotlightRunning
                    ? "Streaming Fullscreen"
                    : "Ready for Instant Viewing"}
                </span>
                <span className="text-xs text-white/55">{stageMeta.audioProfile}</span>
              </div>
            </div>

            {/* Hero Headline, Description & Viewing Comfort Pills */}
            <div className="my-auto py-2">
              <p className="text-xl font-semibold tracking-tight text-white/95 [text-wrap:balance]">
                {stageMeta.tagline}
              </p>
              <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-white/70 [text-wrap:pretty]">
                {stageMeta.description}
              </p>

              {/* Viewing Comfort & Experience Pills */}
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {stageMeta.specs.map((spec) => (
                  <span
                    key={spec}
                    className="rounded-full border border-white/15 bg-black/40 px-3.5 py-1 text-xs font-medium text-white/85"
                  >
                    {spec}
                  </span>
                ))}
              </div>
            </div>

            {/* Tonight's Bedside Lineup (3 Flagship Showcase Cards) */}
            <div className="border-t border-white/10 pt-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-semibold tracking-wider text-white/60 uppercase">
                  Tonight&apos;s Bedside Lineup · Curated for {spotlightTile.label}
                </span>
                <span className="text-xs text-white/50">
                  Use lower deck to preview channels or launch
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3.5">
                {stageMeta.picks.map((pick) => (
                  <div
                    key={pick.title}
                    className="flex min-h-[116px] flex-col justify-between rounded-2xl border border-white/10 bg-black/40 p-3.5 shadow-inner"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-white/80 uppercase">
                          {pick.category}
                        </span>
                        <span className="text-[11px] font-medium tabular-nums text-white/55">
                          {pick.duration}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-1 text-base font-semibold text-white/95">
                        {pick.title}
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-xs text-white/60">
                        {pick.note}
                      </p>
                    </div>

                    <div className="mt-2.5">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className={`h-full rounded-full bg-gradient-to-r ${stageMeta.accentBar}`}
                          style={{ width: `${pick.progressPct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </article>

          {/* Right 4 Columns: Bedside Acoustic Stage & Viewing Comfort Clock */}
          <div className="col-span-4 flex h-full flex-col justify-between gap-4">
            {/* Top Card: Bedside Acoustic Stage & Animated Visualizer */}
            <article className="glass-panel flex flex-1 flex-col justify-between rounded-3xl p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="rounded-xl bg-white/10 p-2.5 text-white/90">
                    <AudioLines className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold tracking-wide text-white">
                      Bedside Acoustic Stage
                    </h3>
                    <p className="text-xs text-white/60">{stageMeta.audioProfile}</p>
                  </div>
                </div>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/15 px-3 py-0.5 text-[11px] font-semibold text-emerald-200">
                  Night Comfort
                </span>
              </div>

              {/* 16-Bar Animated Spectrum Visualizer */}
              <div
                aria-hidden="true"
                className="my-3 flex h-24 items-end justify-between gap-1.5 rounded-2xl border border-white/10 bg-black/45 px-3.5 py-3"
              >
                {stageMeta.spectrumHeights.map((heightPct, idx) => (
                  <span
                    key={idx}
                    className={`w-full animate-pulse rounded-full bg-gradient-to-t opacity-90 transition-all duration-500 ${stageMeta.accentBar}`}
                    style={{
                      height: `${heightPct}%`,
                      animationDelay: `${(idx % 5) * 180}ms`,
                      animationDuration: "2.4s",
                    }}
                  />
                ))}
              </div>

              <div className="flex items-center justify-between text-xs text-white/65">
                <span>Dialog Clarity Boost</span>
                <span className="font-medium text-emerald-300">Sub-Bass Roll-Off Active</span>
              </div>
            </article>

            {/* Bottom Card: Bedside Clock & Viewing Comfort */}
            <article className="glass-panel flex flex-1 flex-col justify-between rounded-3xl p-5">
              <div className="flex items-start justify-between">
                <div>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-white/50 uppercase">
                    <Clock className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                    Bedside Time &amp; Comfort
                  </span>
                  <div className="mt-1 flex items-baseline gap-2">
                    <time className="text-4xl font-light tracking-tight tabular-nums text-white">
                      {time}
                    </time>
                    <span className="text-sm font-medium text-white/65">{period}</span>
                  </div>
                </div>

                <span
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    activeTile
                      ? "border-emerald-400/35 bg-emerald-500/15 text-emerald-200"
                      : "border-white/15 bg-white/10 text-white/80"
                  }`}
                >
                  {activeTile ? "Streaming Fullscreen" : "Ready on Stage"}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
                  <p className="text-[10px] font-medium text-white/50 uppercase">Display Tone</p>
                  <p className="mt-0.5 font-semibold text-amber-200">Eye-Care Warmth</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
                  <p className="text-[10px] font-medium text-white/50 uppercase">Audio Curve</p>
                  <p className="mt-0.5 font-semibold text-white/90">Midnight Whisper</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
                  <p className="text-[10px] font-medium text-white/50 uppercase">Session Resume</p>
                  <p className="mt-0.5 font-semibold text-white/90">One-Tap Instant</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
                  <p className="text-[10px] font-medium text-white/50 uppercase">Sleep Guard</p>
                  <p className="mt-0.5 font-semibold text-sky-300">Auto-Pause Ready</p>
                </div>
              </div>
            </article>
          </div>
        </div>
      </div>

      {/* =====================================================================
          LOWER HALF: ERGONOMIC TOUCH DECK (y = 646..986px, 100% interactive)
          All interactive controls sit inside working touch rows (y >= 610px)
          and finish 8px above the y = 994px global pane indicator dots.
         ===================================================================== */}
      <div className="relative z-10 mt-auto flex flex-col gap-4">
        {/* Interactive Control, Service Preview Switcher & Stage Launch CTA Bar */}
        <div className="flex min-h-[56px] flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onNavigateHub}
            className="glass-panel touch-target flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white/90 hover:bg-white/15"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span>Hub</span>
          </button>

          {/* Bottom-Controlled Stage Spotlight Switcher with Clear Service Icons & Labels */}
          <div
            role="group"
            aria-label="Upper stage channel selector"
            className="glass-panel flex items-center gap-1.5 rounded-full p-1.5"
          >
            <button
              type="button"
              aria-label="Previous stage spotlight"
              onClick={() => cycleSpotlight(-1)}
              className="touch-target flex items-center justify-center rounded-full px-3 py-2 text-xs font-medium text-white/75 hover:bg-white/15 hover:text-white"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>

            {tiles.map((tile, index) => {
              const isSelected = spotlightTile.id === tile.id;
              const pillStyle = TILE_STAGE_CATALOG[tile.id] ?? FALLBACK_STAGE;
              const PillIcon = pillStyle.Icon;
              return (
                <button
                  key={tile.id}
                  type="button"
                  aria-label={`Spotlight channel ${index + 1}`}
                  aria-pressed={isSelected}
                  onClick={() => setSpotlightId(tile.id)}
                  className={`touch-target flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition ${
                    isSelected
                      ? "bg-white text-slate-950 shadow-md"
                      : "text-white/75 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <PillIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span aria-hidden="true">{tile.label}</span>
                </button>
              );
            })}

            <button
              type="button"
              aria-label="Next stage spotlight"
              onClick={() => cycleSpotlight(1)}
              className="touch-target flex items-center justify-center rounded-full px-3 py-2 text-xs font-medium text-white/75 hover:bg-white/15 hover:text-white"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {/* Primary Stage Launch CTA Button */}
          <button
            type="button"
            aria-label="Open spotlighted stage service"
            onClick={() => onLaunchTile(spotlightTile.id)}
            className={`touch-target flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-semibold backdrop-blur-xl transition ${stageMeta.ctaStyle}`}
          >
            <Play className="h-4 w-4 fill-current" aria-hidden="true" />
            <span aria-hidden="true">
              {isSpotlightRunning
                ? `Return to ${spotlightTile.label}`
                : `Watch ${spotlightTile.label}`}
            </span>
          </button>
        </div>

        {/* 5-Column Tactile Service Launcher Deck (min-h-[268px]) */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
          {tiles.map((tile, index) => {
            const style = TILE_STAGE_CATALOG[tile.id] ?? {
              ...FALLBACK_STAGE,
              channelLabel: `Channel 0${index + 1}`,
              subtitle: "Bedside Stream",
            };
            const Icon = style.Icon;
            const isRunning = activeTileId === tile.id;
            const isSpotlighted = spotlightTile.id === tile.id;
            const leadPick = style.picks[0];

            return (
              <button
                key={tile.id}
                type="button"
                onPointerEnter={() => setSpotlightId(tile.id)}
                onFocus={() => setSpotlightId(tile.id)}
                onClick={() => {
                  setSpotlightId(tile.id);
                  onLaunchTile(tile.id);
                }}
                className={`touch-target group relative flex min-h-[268px] flex-col justify-between overflow-hidden rounded-3xl border bg-gradient-to-br p-5 text-left backdrop-blur-xl transition duration-200 hover:brightness-110 active:brightness-110 ${
                  style.gradient
                } ${
                  isRunning
                    ? "ring-2 ring-emerald-400/80 shadow-[0_0_35px_-5px_rgba(52,211,153,0.35)]"
                    : isSpotlighted
                      ? `${style.spotlightRing} -translate-y-0.5`
                      : ""
                }`}
              >
                {/* Top Accent Highlight Bar when Spotlighted on Upper Stage */}
                {isSpotlighted && (
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-x-6 top-0 h-1 rounded-b-full bg-gradient-to-r ${style.accentBar}`}
                  />
                )}

                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl border border-white/15 bg-white/10 p-3.5 shadow-md transition group-hover:bg-white/15">
                      <Icon className="h-6 w-6 text-white" aria-hidden="true" />
                    </div>
                  </div>

                  {isRunning ? (
                    <span className="rounded-full border border-emerald-400/40 bg-emerald-400/20 px-3 py-1 text-xs font-semibold text-emerald-200">
                      Resume
                    </span>
                  ) : isSpotlighted ? (
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${style.accentBadge}`}
                    >
                      On Stage
                    </span>
                  ) : (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-white/65 group-hover:border-white/25 group-hover:text-white/90">
                      Tap to Open
                    </span>
                  )}
                </div>

                <div className="my-auto py-2">
                  <p className="text-xl font-bold tracking-tight text-white">{tile.label}</p>
                  <p className="mt-0.5 text-xs font-medium text-white/75">{style.subtitle}</p>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-white/60">
                    {style.cardSummary}
                  </p>
                </div>

                <div className="flex items-center justify-between border-t border-white/10 pt-3 text-xs">
                  <span className="truncate font-medium text-white/65">
                    {leadPick ? leadPick.category : style.categoryTag}
                  </span>
                  <span
                    className={`shrink-0 font-semibold ${
                      isRunning
                        ? "text-emerald-300"
                        : isSpotlighted
                          ? "text-white"
                          : "text-white/70 group-hover:text-white"
                    }`}
                  >
                    {isRunning ? "Playing" : isSpotlighted ? "Featured ↑" : "Launch →"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
