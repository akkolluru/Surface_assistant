import type { ReactNode } from "react";

/** Visual theme tokens associated with a media launcher brand tile. */
export interface BrandTheme {
  rgb: string;
  accentHex: string;
  ringClass: string;
}

/** Props for rendering a brand SVG emblem in either stage or dial context. */
export interface MediaBrandLogoProps {
  tileId: string;
  variant: "hologram" | "dial";
  className?: string;
}

/** Per-brand theme lookup keyed by normalized media tile identifier. */
export const BRAND_THEMES: Record<string, BrandTheme> = {
  youtube: {
    rgb: "244, 63, 94",
    accentHex: "#F43F5E",
    ringClass: "border-rose-400/40 ring-rose-400/55",
  },
  netflix: {
    rgb: "229, 9, 20",
    accentHex: "#E50914",
    ringClass: "border-red-400/40 ring-red-500/55",
  },
  prime: {
    rgb: "0, 168, 225",
    accentHex: "#00A8E1",
    ringClass: "border-sky-400/40 ring-sky-400/55",
  },
  anime: {
    rgb: "167, 139, 250",
    accentHex: "#A78BFA",
    ringClass: "border-violet-400/40 ring-violet-400/55",
  },
  stremio: {
    rgb: "129, 140, 248",
    accentHex: "#818CF8",
    ringClass: "border-indigo-400/40 ring-indigo-400/55",
  },
};

/** Neutral slate fallback theme for custom or unrecognized media tiles. */
export const FALLBACK_BRAND_THEME: BrandTheme = {
  rgb: "148, 163, 184",
  accentHex: "#94A3B8",
  ringClass: "border-white/20 ring-slate-400/45",
};

/**
 * Resolves the `BrandTheme` for a given `tileId`, falling back cleanly to
 * `FALLBACK_BRAND_THEME` for unknown or custom entries.
 */
export function getBrandTheme(tileId: string): BrandTheme {
  const normalized = tileId.trim().toLowerCase();
  if (Object.hasOwn(BRAND_THEMES, normalized)) {
    return BRAND_THEMES[normalized] ?? FALLBACK_BRAND_THEME;
  }
  return FALLBACK_BRAND_THEME;
}

function renderBrandMark(normalizedId: string, isHologram: boolean): ReactNode {
  switch (normalizedId) {
    case "youtube":
      return (
        <>
          <rect
            x="8"
            y="15"
            width="48"
            height="34"
            rx="10"
            fill="#F43F5E"
            fillOpacity={isHologram ? 0.24 : 0.18}
            stroke="#FB7185"
            strokeOpacity={isHologram ? 0.92 : 0.85}
            strokeWidth={isHologram ? 2.2 : 2.5}
          />
          <path d="M27 23.5L42 32L27 40.5Z" fill="#FFFFFF" />
        </>
      );
    case "netflix":
      return (
        <>
          <path d="M19 12H26.5V52H19Z" fill="#B91C1C" />
          <path d="M37.5 12H45V52H37.5Z" fill="#B91C1C" />
          <path
            d="M19 12H26.5L45 52H37.5Z"
            fill="#EF4444"
            stroke={isHologram ? "#FECACA" : undefined}
            strokeOpacity={isHologram ? 0.3 : undefined}
            strokeWidth={isHologram ? 0.8 : undefined}
          />
        </>
      );
    case "prime":
      return (
        <>
          <circle
            cx="32"
            cy="23.5"
            r="11.5"
            fill="#00A8E1"
            fillOpacity={isHologram ? 0.16 : 0.11}
            stroke="#00A8E1"
            strokeOpacity={isHologram ? 0.68 : 0.55}
            strokeWidth={isHologram ? 2 : 2.2}
          />
          <path d="M28.5 18L38.5 23.5L28.5 29Z" fill="#FFFFFF" />
          <path
            d="M15 41.5C24.5 48.5 39.5 48.5 49 41.5"
            fill="none"
            stroke="#00A8E1"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
          <path
            d="M44 40L49.5 41L47.5 46.5"
            fill="none"
            stroke="#00A8E1"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "anime":
      return (
        <>
          {/* Architectural Torii gate keeps anime unmistakable from Night Mode's crescent moon. */}
          <path
            d="M10 18.5C21 21 43 21 54 18.5L52 23.5C42 25.2 22 25.2 12 23.5Z"
            fill="#DDD6FE"
          />
          <rect x="29.75" y="23.5" width="4.5" height="6" fill="#C4B5FD" />
          <rect x="15" y="29" width="34" height="4.2" rx="1.6" fill="#A78BFA" />
          <rect
            x="19.5"
            y="23.5"
            width="4.6"
            height="27.5"
            rx="1.2"
            fill="#A78BFA"
            fillOpacity={isHologram ? 0.95 : 1}
          />
          <rect
            x="39.9"
            y="23.5"
            width="4.6"
            height="27.5"
            rx="1.2"
            fill="#A78BFA"
            fillOpacity={isHologram ? 0.95 : 1}
          />
          <rect x="18" y="48.5" width="7.6" height="3.2" rx="1" fill="#DDD6FE" fillOpacity="0.85" />
          <rect x="38.4" y="48.5" width="7.6" height="3.2" rx="1" fill="#DDD6FE" fillOpacity="0.85" />
        </>
      );
    case "stremio":
      return (
        <>
          <rect
            x="15"
            y="15"
            width="34"
            height="34"
            rx="7"
            transform="rotate(45 32 32)"
            fill="#818CF8"
            fillOpacity={isHologram ? 0.24 : 0.18}
            stroke="#818CF8"
            strokeOpacity={isHologram ? 0.95 : 0.88}
            strokeWidth={isHologram ? 2.2 : 2.5}
          />
          <path d="M27.5 23.5L41.5 32L27.5 40.5Z" fill="#FFFFFF" />
        </>
      );
    default:
      return (
        <>
          <rect
            x="10"
            y="16"
            width="44"
            height="32"
            rx="7"
            fill="#94A3B8"
            fillOpacity={isHologram ? 0.18 : 0.14}
            stroke="#94A3B8"
            strokeOpacity={isHologram ? 0.88 : 0.8}
            strokeWidth={isHologram ? 2.2 : 2.4}
          />
          <path d="M27.5 24L40.5 32L27.5 40Z" fill="#F8FAFC" />
        </>
      );
  }
}

/**
 * Renders a decorative crisp vector brand emblem (`aria-hidden`) tailored for either
 * the central ambient stage (`"hologram"`) or orbital launcher slots (`"dial"`).
 */
export function MediaBrandLogo({ tileId, variant, className }: MediaBrandLogoProps) {
  const normalized = tileId.trim().toLowerCase();
  const isHologram = variant === "hologram";
  const resolvedClassName = className
    ? `shrink-0 ${className}`
    : isHologram
      ? "h-16 w-16 shrink-0"
      : "h-7 w-7 shrink-0";

  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      className={resolvedClassName}
    >
      {renderBrandMark(normalized, isHologram)}
    </svg>
  );
}
