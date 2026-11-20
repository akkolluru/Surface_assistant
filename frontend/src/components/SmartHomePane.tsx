import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronRight,
  Fan,
  Lamp,
  Lightbulb,
  Minus,
  Plug,
  Plus,
  RefreshCw,
  Snowflake,
  type LucideIcon,
} from "lucide-react";
import type { SmartEntityState } from "../types/hub";

/** Props accepted by the {@link SmartHomePane} bedside control deck. */
export interface SmartHomePaneProps {
  entities: Record<string, SmartEntityState>;
  haConnected: boolean;
  onCallService: (domain: string, service: string, data: Record<string, unknown>) => void;
  onNavigateHub: () => void;
}

const SCENES = [
  { id: "scene.evening_relax", label: "Relax" },
  { id: "scene.movie_night", label: "Movie" },
  { id: "scene.goodnight", label: "Goodnight" },
] as const;

const AC_MODES = ["Cool", "Dry", "Fan", "Eco"] as const;
type AcMode = (typeof AC_MODES)[number];

const MIN_BRIGHTNESS = 5;
const MAX_BRIGHTNESS = 100;
const BRIGHTNESS_STEP = 5;
const DEFAULT_BRIGHTNESS = 60;

const MIN_AC_TEMP = 18;
const MAX_AC_TEMP = 30;
const DEFAULT_AC_TEMP = 24;

const SCENE_PULSE_MS = 1500;
const OPTIMISTIC_RECONCILE_MS = 900;
const BRIGHTNESS_THROTTLE_MS = 80;

type AccentTone = "amber" | "sky" | "emerald";

const TONE_ACTIVE_CLASSES: Record<AccentTone, string> = {
  amber: "border-amber-400/45 bg-amber-400/20 text-amber-100 hover:bg-amber-400/25",
  sky: "border-sky-400/45 bg-sky-400/20 text-sky-100 hover:bg-sky-400/25",
  emerald: "border-emerald-400/45 bg-emerald-400/20 text-emerald-100 hover:bg-emerald-400/25",
};

type SliderStyleProperties = CSSProperties & {
  "--slider-progress": string;
  "--slider-fill-color": string;
  "--slider-thumb-color": string;
  "--slider-track-color": string;
  "--slider-focus-color": string;
};

function parseFiniteNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function resolveAcMode(rawMode: string | undefined): AcMode {
  const normalized = rawMode?.trim().toLowerCase();
  if (!normalized) return "Cool";
  return AC_MODES.find((mode) => mode.toLowerCase() === normalized) ?? "Cool";
}

function getNextAcMode(current: AcMode): AcMode {
  const idx = AC_MODES.indexOf(current);
  return AC_MODES[(idx + 1) % AC_MODES.length] ?? "Cool";
}

function formatLightsReadout(
  mainLightOn: boolean,
  lampOn: boolean,
  brightness: number
): { value: string; caption: string } {
  const value = mainLightOn ? `${brightness}%` : "Warm";
  if (mainLightOn && lampOn) {
    return { value, caption: "Ceiling · Lamp" };
  }
  return { value, caption: mainLightOn ? "Ceiling" : "Bedside Lamp" };
}

function formatOutletsSummary(deskPlugOn: boolean, fanPlugOn: boolean): string {
  const active: string[] = [];
  if (deskPlugOn) active.push("Desk Plug");
  if (fanPlugOn) active.push("Standing Fan");
  return active.join(" · ");
}

function buildAmbientHaloGlow(
  rgb: string,
  peakOpacity: number,
  tailOpacity: number,
  pos: string,
  size: string
): string {
  const peak = peakOpacity.toFixed(3);
  const tail = tailOpacity.toFixed(3);
  return `radial-gradient(${size} at ${pos}, rgba(${rgb}, ${peak}) 0%, rgba(${rgb}, ${tail}) 42%, rgba(0, 0, 0, 0) 78%)`;
}

function buildAmberHorizonGlow(mainLightOn: boolean, brightness: number, blended: boolean): string {
  const amberStrength = mainLightOn ? 0.1 + (brightness / MAX_BRIGHTNESS) * 0.14 : 0.14;
  return buildAmbientHaloGlow(
    "251, 191, 36",
    amberStrength,
    amberStrength * 0.36,
    blended ? "39% 29%" : "50% 29%",
    blended ? "38% 30%" : "46% 32%"
  );
}

function buildSkyHorizonGlow(blended: boolean): string {
  const peak = blended ? 0.16 : 0.18;
  const tail = blended ? 0.055 : 0.065;
  return buildAmbientHaloGlow(
    "56, 189, 248",
    peak,
    tail,
    blended ? "61% 29%" : "50% 29%",
    blended ? "38% 30%" : "46% 32%"
  );
}

function buildSliderStyle(brightness: number, mainLightOn: boolean): SliderStyleProperties {
  const ratio = ((brightness - MIN_BRIGHTNESS) / (MAX_BRIGHTNESS - MIN_BRIGHTNESS)) * 100;
  const clampedProgress = Math.min(100, Math.max(0, ratio));
  const progress = `${clampedProgress.toFixed(2)}%`;

  if (mainLightOn) {
    return {
      "--slider-progress": progress,
      "--slider-fill-color": "#fbbf24",
      "--slider-thumb-color": "#ffffff",
      "--slider-track-color": "rgba(255, 255, 255, 0.36)",
      "--slider-focus-color": "#fbbf24",
    };
  }

  return {
    "--slider-progress": progress,
    "--slider-fill-color": "#94a3b8",
    "--slider-thumb-color": "#e2e8f0",
    "--slider-track-color": "rgba(203, 213, 225, 0.44)",
    "--slider-focus-color": "#94a3b8",
  };
}

interface AmbientBackdropProps {
  anyLightOn: boolean;
  mainLightOn: boolean;
  brightness: number;
  acOn: boolean;
}

/** Full-pane non-interactive atmospheric halo centered behind the upper stage focal display. */
function AmbientBackdrop({ anyLightOn, mainLightOn, brightness, acOn }: AmbientBackdropProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="ambient-horizon-glow"
      className="pointer-events-none absolute inset-0"
    >
      <div
        data-testid="ambient-horizon-amber"
        className={`absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none ${
          anyLightOn ? "opacity-100" : "opacity-0"
        }`}
        style={{
          background: buildAmberHorizonGlow(mainLightOn, brightness, acOn),
        }}
      />
      <div
        data-testid="ambient-horizon-sky"
        className={`absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none ${
          acOn ? "opacity-100" : "opacity-0"
        }`}
        style={{
          background: buildSkyHorizonGlow(anyLightOn),
        }}
      />
    </div>
  );
}

interface AmbientStageProps {
  haConnected: boolean;
  mainLightOn: boolean;
  lampOn: boolean;
  brightness: number;
  acOn: boolean;
  acTemp: number;
  acMode: AcMode;
  deskPlugOn: boolean;
  fanPlugOn: boolean;
}

/** Upper 58vh non-interactive ambient projection stage readable from bed. */
function AmbientStage({
  haConnected,
  mainLightOn,
  lampOn,
  brightness,
  acOn,
  acTemp,
  acMode,
  deskPlugOn,
  fanPlugOn,
}: AmbientStageProps) {
  const anyLightOn = mainLightOn || lampOn;
  const lightsReadout = formatLightsReadout(mainLightOn, lampOn, brightness);
  const outletsSummary = formatOutletsSummary(deskPlugOn, fanPlugOn);

  const singleRingSpec = anyLightOn
    ? {
        ringClasses: "border-amber-400/20 bg-amber-400/[0.03]",
        valueClasses: "text-5xl font-light tracking-tight tabular-nums text-amber-100",
        captionClasses: "text-amber-200/75",
        value: lightsReadout.value,
        caption: lightsReadout.caption,
      }
    : acOn
      ? {
          ringClasses: "border-sky-400/20 bg-sky-400/[0.03]",
          valueClasses: "text-5xl font-light tracking-tight tabular-nums text-sky-100",
          captionClasses: "text-sky-200/75",
          value: `${acTemp}°C`,
          caption: `AC · ${acMode}`,
        }
      : {
          ringClasses: "border-white/10 bg-white/[0.02]",
          valueClasses: "text-2xl font-light tracking-tight text-white/85 md:text-3xl",
          captionClasses: "text-white/55",
          value: outletsSummary ? "Outlets Active" : "All Quiet",
          caption: outletsSummary || "Bedroom resting",
        };

  return (
    <div className="pointer-events-none relative z-10 flex h-[58vh] w-full shrink-0 flex-col items-center justify-center px-6 lg:px-10">
      <div className="absolute top-8 left-6 flex items-center gap-2 text-xs font-medium tracking-wide text-white/55 lg:left-10">
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${haConnected ? "bg-emerald-400" : "bg-white/35"}`}
        />
        <span>{haConnected ? "HA Live" : "HA Preview"}</span>
      </div>

      {anyLightOn && acOn ? (
        <div className="relative z-10 flex items-baseline gap-12 text-center">
          <div className="flex flex-col items-center">
            <p className="text-5xl font-light tracking-tight tabular-nums text-amber-200 md:text-6xl">
              {lightsReadout.value}
            </p>
            <p className="mt-2 text-xs font-medium tracking-wide text-amber-200/75">
              {lightsReadout.caption}
            </p>
          </div>
          <div className="flex flex-col items-center">
            <p className="text-5xl font-light tracking-tight tabular-nums text-sky-200 md:text-6xl">
              {acTemp}°C
            </p>
            <p className="mt-2 text-xs font-medium tracking-wide text-sky-200/75">
              AC · {acMode}
            </p>
          </div>
        </div>
      ) : (
        <div
          className={`relative z-10 flex h-56 w-56 flex-col items-center justify-center rounded-full border px-6 text-center md:h-64 md:w-64 ${singleRingSpec.ringClasses}`}
        >
          <p className={singleRingSpec.valueClasses}>{singleRingSpec.value}</p>
          <p className={`mt-2 text-xs font-medium tracking-wide ${singleRingSpec.captionClasses}`}>
            {singleRingSpec.caption}
          </p>
        </div>
      )}
    </div>
  );
}

interface SceneRailProps {
  scenePulseId: string | null;
  onTriggerScene: (sceneId: string) => void;
  onNavigateHub: () => void;
}

/** Lower-deck Tier 1 action rail: one-tap scene triggers and Hub return pill. */
function SceneRail({ scenePulseId, onTriggerScene, onNavigateHub }: SceneRailProps) {
  return (
    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        {SCENES.map((scene) => {
          const isPulsing = scenePulseId === scene.id;
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => onTriggerScene(scene.id)}
              className={`touch-target rounded-full border px-4 py-2 text-xs font-medium transition-colors lg:text-sm ${
                isPulsing
                  ? "scene-pulse border-violet-400/50 bg-violet-400/20 text-violet-100"
                  : "border-white/15 bg-white/[0.04] text-white/85 hover:bg-white/[0.09]"
              }`}
            >
              {scene.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onNavigateHub}
        className="touch-target flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-xs font-medium text-white/85 transition-colors hover:bg-white/[0.09] lg:text-sm"
      >
        <span>Hub</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

interface FixtureToggleProps {
  label: string;
  Icon: LucideIcon;
  isOn: boolean;
  tone: AccentTone;
  onToggle: () => void;
}

/** Shared accessible fixture toggle button displaying visible On/Off state without duplicating ARIA label. */
function FixtureToggle({ label, Icon, isOn, tone, onToggle }: FixtureToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={isOn}
      onClick={onToggle}
      className={`touch-target flex h-[54px] w-full items-center justify-between gap-2 rounded-2xl border px-3 text-xs font-medium transition-colors lg:px-4 lg:text-sm ${
        isOn
          ? TONE_ACTIVE_CLASSES[tone]
          : "border-white/10 bg-white/[0.04] text-white/85 hover:bg-white/[0.08]"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-xs font-semibold">
        {isOn ? "On" : "Off"}
      </span>
    </button>
  );
}

/** Manage optimistic brightness state during pointer/touch drags with 900ms HA reconciliation. */
function useOptimisticBrightness(
  propBrightness: number,
  onCallService: SmartHomePaneProps["onCallService"]
) {
  const [pendingBrightness, setPendingBrightness] = useState<number | null>(null);
  const isSlidingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const pendingBrightnessRef = useRef<number | null>(null);
  const reconcileTimerRef = useRef<number | null>(null);
  const throttleTimerRef = useRef<number | null>(null);
  const lastDispatchedRef = useRef<number | null>(null);
  const lastDispatchAtRef = useRef(0);
  const prevPropRef = useRef(propBrightness);
  const propRef = useRef(propBrightness);
  const onCallServiceRef = useRef(onCallService);

  propRef.current = propBrightness;
  onCallServiceRef.current = onCallService;

  const clearReconcileTimer = useCallback(() => {
    if (reconcileTimerRef.current !== null) {
      window.clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
    }
  }, []);

  const clearThrottleTimer = useCallback(() => {
    if (throttleTimerRef.current !== null) {
      window.clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
  }, []);

  const clearPending = useCallback(() => {
    clearReconcileTimer();
    pendingBrightnessRef.current = null;
    setPendingBrightness(null);
  }, [clearReconcileTimer]);

  const scheduleReconcile = useCallback(() => {
    clearReconcileTimer();
    reconcileTimerRef.current = window.setTimeout(() => {
      reconcileTimerRef.current = null;
      pendingBrightnessRef.current = null;
      setPendingBrightness(null);
    }, OPTIMISTIC_RECONCILE_MS);
  }, [clearReconcileTimer]);

  const dispatchBrightness = useCallback((value: number) => {
    lastDispatchedRef.current = value;
    lastDispatchAtRef.current = Date.now();
    onCallServiceRef.current("input_number", "set_value", {
      entity_id: "input_number.bedroom_light_brightness",
      value,
    });
  }, []);

  const endSlide = useCallback(
    (pointerId?: number) => {
      if (!isSlidingRef.current) return;
      if (
        pointerId !== undefined &&
        activePointerIdRef.current !== null &&
        pointerId !== activePointerIdRef.current
      ) {
        return;
      }

      isSlidingRef.current = false;
      activePointerIdRef.current = null;
      clearThrottleTimer();

      const pending = pendingBrightnessRef.current;
      if (pending !== null && lastDispatchedRef.current !== pending) {
        dispatchBrightness(pending);
      }
      lastDispatchedRef.current = null;

      if (pending === null) return;
      if (pending === propRef.current) {
        clearPending();
      } else {
        scheduleReconcile();
      }
    },
    [clearPending, clearThrottleTimer, dispatchBrightness, scheduleReconcile]
  );

  useEffect(() => {
    const prev = prevPropRef.current;
    prevPropRef.current = propBrightness;
    if (prev === propBrightness || isSlidingRef.current) return;
    clearPending();
  }, [propBrightness, clearPending]);

  useEffect(() => {
    const onWindowPointerEnd = (event: globalThis.PointerEvent) =>
      endSlide(Number.isFinite(event.pointerId) ? event.pointerId : undefined);
    window.addEventListener("pointerup", onWindowPointerEnd);
    window.addEventListener("pointercancel", onWindowPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerEnd);
      window.removeEventListener("pointercancel", onWindowPointerEnd);
      clearReconcileTimer();
      clearThrottleTimer();
    };
  }, [endSlide, clearReconcileTimer, clearThrottleTimer]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLInputElement>) => {
      isSlidingRef.current = true;
      activePointerIdRef.current = Number.isFinite(event.pointerId) ? event.pointerId : null;
      lastDispatchedRef.current = null;
      clearReconcileTimer();
      clearThrottleTimer();
    },
    [clearReconcileTimer, clearThrottleTimer]
  );

  const handleChange = useCallback(
    (rawValue: string) => {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) return;

      const nextValue = clampInt(parsed, MIN_BRIGHTNESS, MAX_BRIGHTNESS);
      pendingBrightnessRef.current = nextValue;
      setPendingBrightness(nextValue);

      if (!isSlidingRef.current) {
        clearThrottleTimer();
        dispatchBrightness(nextValue);
        scheduleReconcile();
        return;
      }

      if (lastDispatchedRef.current === nextValue) {
        clearThrottleTimer();
        return;
      }

      const elapsed = Date.now() - lastDispatchAtRef.current;
      if (lastDispatchedRef.current === null || elapsed >= BRIGHTNESS_THROTTLE_MS) {
        clearThrottleTimer();
        dispatchBrightness(nextValue);
        return;
      }

      if (throttleTimerRef.current === null) {
        throttleTimerRef.current = window.setTimeout(() => {
          throttleTimerRef.current = null;
          const latest = pendingBrightnessRef.current;
          if (latest !== null && lastDispatchedRef.current !== latest) {
            dispatchBrightness(latest);
          }
        }, BRIGHTNESS_THROTTLE_MS - elapsed);
      }
    },
    [clearThrottleTimer, dispatchBrightness, scheduleReconcile]
  );

  return {
    effectiveBrightness: pendingBrightness ?? propBrightness,
    handlePointerDown,
    handlePointerUp: (event: ReactPointerEvent<HTMLInputElement>) =>
      endSlide(Number.isFinite(event.pointerId) ? event.pointerId : undefined),
    handlePointerCancel: (event: ReactPointerEvent<HTMLInputElement>) =>
      endSlide(Number.isFinite(event.pointerId) ? event.pointerId : undefined),
    handleBlur: () => endSlide(),
    handleChange,
  };
}

/** Manage optimistic AC target temperature across rapid taps with 900ms HA reconciliation. */
function useOptimisticAcTemp(
  propAcTemp: number,
  onCallService: SmartHomePaneProps["onCallService"]
) {
  const [pendingAcTemp, setPendingAcTemp] = useState<number | null>(null);
  const pendingAcTempRef = useRef<number | null>(null);
  const reconcileTimerRef = useRef<number | null>(null);
  const prevPropRef = useRef(propAcTemp);
  const propRef = useRef(propAcTemp);
  const onCallServiceRef = useRef(onCallService);

  propRef.current = propAcTemp;
  onCallServiceRef.current = onCallService;

  const clearReconcileTimer = useCallback(() => {
    if (reconcileTimerRef.current !== null) {
      window.clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearReconcileTimer, [clearReconcileTimer]);

  useEffect(() => {
    if (prevPropRef.current === propAcTemp) return;
    prevPropRef.current = propAcTemp;
    clearReconcileTimer();
    pendingAcTempRef.current = null;
    setPendingAcTemp(null);
  }, [propAcTemp, clearReconcileTimer]);

  const stepAcTemp = useCallback(
    (delta: -1 | 1) => {
      const currentTemp = pendingAcTempRef.current ?? propRef.current;
      const nextTemp = clampInt(currentTemp + delta, MIN_AC_TEMP, MAX_AC_TEMP);
      if (nextTemp === currentTemp) return;

      pendingAcTempRef.current = nextTemp;
      setPendingAcTemp(nextTemp);

      clearReconcileTimer();
      reconcileTimerRef.current = window.setTimeout(() => {
        reconcileTimerRef.current = null;
        pendingAcTempRef.current = null;
        setPendingAcTemp(null);
      }, OPTIMISTIC_RECONCILE_MS);

      onCallServiceRef.current("input_number", "set_value", {
        entity_id: "input_number.bedroom_ac_temp",
        value: nextTemp,
      });
    },
    [clearReconcileTimer]
  );

  return {
    effectiveAcTemp: pendingAcTemp ?? propAcTemp,
    stepAcTemp,
  };
}

/**
 * Bedside Smart Home pane engineered for Surface Pro 5 digitizer geometry:
 * upper 58vh non-interactive ambient stage + lower 42vh touch deck.
 */
export function SmartHomePane({
  entities,
  haConnected,
  onCallService,
  onNavigateHub,
}: SmartHomePaneProps) {
  const brightnessId = useId();
  const [scenePulseId, setScenePulseId] = useState<string | null>(null);
  const sceneTimerRef = useRef<number | null>(null);

  const clearSceneTimer = useCallback(() => {
    if (sceneTimerRef.current !== null) {
      window.clearTimeout(sceneTimerRef.current);
      sceneTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSceneTimer, [clearSceneTimer]);

  const handleTriggerScene = (sceneId: string) => {
    onCallService("scene", "turn_on", { entity_id: sceneId });
    clearSceneTimer();
    setScenePulseId(sceneId);
    sceneTimerRef.current = window.setTimeout(() => {
      setScenePulseId(null);
      sceneTimerRef.current = null;
    }, SCENE_PULSE_MS);
  };

  const mainLightOn = entities["input_boolean.bedroom_main_light"]?.state === "on";
  const lampOn = entities["input_boolean.bedside_lamp"]?.state === "on";
  const propBrightness = clampInt(
    parseFiniteNumber(entities["input_number.bedroom_light_brightness"]?.state, DEFAULT_BRIGHTNESS),
    MIN_BRIGHTNESS,
    MAX_BRIGHTNESS
  );

  const acOn = entities["input_boolean.bedroom_ac_power"]?.state === "on";
  const propAcTemp = clampInt(
    parseFiniteNumber(entities["input_number.bedroom_ac_temp"]?.state, DEFAULT_AC_TEMP),
    MIN_AC_TEMP,
    MAX_AC_TEMP
  );
  const acMode = resolveAcMode(entities["input_select.bedroom_ac_mode"]?.state);
  const nextAcMode = getNextAcMode(acMode);

  const deskPlugOn = entities["input_boolean.desk_plug"]?.state === "on";
  const fanPlugOn = entities["input_boolean.fan_plug"]?.state === "on";

  const {
    effectiveBrightness,
    handlePointerDown: handleBrightnessPointerDown,
    handlePointerUp: handleBrightnessPointerUp,
    handlePointerCancel: handleBrightnessPointerCancel,
    handleBlur: handleBrightnessBlur,
    handleChange: handleBrightnessChange,
  } = useOptimisticBrightness(propBrightness, onCallService);

  const { effectiveAcTemp, stepAcTemp } = useOptimisticAcTemp(propAcTemp, onCallService);

  const anyLightOn = mainLightOn || lampOn;

  const toggleBool = (entityId: string) =>
    onCallService("input_boolean", "toggle", { entity_id: entityId });

  return (
    <section
      aria-label="Smart Home Controls"
      className="pane-item relative flex h-full w-full flex-col overflow-hidden bg-black text-white select-none"
    >
      <AmbientBackdrop
        anyLightOn={anyLightOn}
        mainLightOn={mainLightOn}
        brightness={effectiveBrightness}
        acOn={acOn}
      />

      <AmbientStage
        haConnected={haConnected}
        mainLightOn={mainLightOn}
        lampOn={lampOn}
        brightness={effectiveBrightness}
        acOn={acOn}
        acTemp={effectiveAcTemp}
        acMode={acMode}
        deskPlugOn={deskPlugOn}
        fanPlugOn={fanPlugOn}
      />

      <div className="relative z-10 flex h-[42vh] w-full shrink-0 flex-col justify-end px-6 pt-3 pb-14 lg:px-10">
        <SceneRail
          scenePulseId={scenePulseId}
          onTriggerScene={handleTriggerScene}
          onNavigateHub={onNavigateHub}
        />

        <div className="grid grid-cols-1 gap-y-4 md:grid-cols-[5fr_4fr_3fr] md:gap-y-0 md:divide-x md:divide-white/10">
          {/* Lighting (5fr) */}
          <div
            role="group"
            aria-label="Lighting"
            className="flex flex-col gap-2.5 md:pr-4 lg:pr-7"
          >
            <div className="grid grid-cols-2 gap-2.5">
              <FixtureToggle
                label="Ceiling"
                Icon={Lightbulb}
                isOn={mainLightOn}
                tone="amber"
                onToggle={() => toggleBool("input_boolean.bedroom_main_light")}
              />
              <FixtureToggle
                label="Bedside Lamp"
                Icon={Lamp}
                isOn={lampOn}
                tone="amber"
                onToggle={() => toggleBool("input_boolean.bedside_lamp")}
              />
            </div>

            <div
              className={`flex h-[54px] items-center gap-3 rounded-2xl border px-3 transition-colors lg:px-4 ${
                mainLightOn
                  ? "border-amber-400/25 bg-amber-400/[0.08]"
                  : "border-white/10 bg-white/[0.04]"
              }`}
            >
              <label
                htmlFor={brightnessId}
                className={`shrink-0 text-xs font-medium lg:text-sm ${
                  mainLightOn ? "text-amber-100/90" : "text-white/75"
                }`}
              >
                Brightness
              </label>
              <input
                id={brightnessId}
                type="range"
                min={MIN_BRIGHTNESS}
                max={MAX_BRIGHTNESS}
                step={BRIGHTNESS_STEP}
                value={effectiveBrightness}
                aria-valuetext={`${effectiveBrightness}%`}
                onPointerDown={handleBrightnessPointerDown}
                onPointerUp={handleBrightnessPointerUp}
                onPointerCancel={handleBrightnessPointerCancel}
                onBlur={handleBrightnessBlur}
                onChange={(e) => handleBrightnessChange(e.target.value)}
                className="hub-range flex-1"
                style={buildSliderStyle(effectiveBrightness, mainLightOn)}
              />
              <span
                className={`w-10 shrink-0 text-right text-xs font-semibold tabular-nums lg:text-sm ${
                  mainLightOn ? "text-amber-100" : "text-white/80"
                }`}
              >
                {effectiveBrightness}%
              </span>
            </div>
          </div>

          {/* Climate (4fr) */}
          <div
            role="group"
            aria-label="Climate"
            className="flex flex-col gap-2.5 md:px-4 lg:px-7"
          >
            <div className="grid grid-cols-2 gap-2.5">
              <FixtureToggle
                label="AC"
                Icon={Snowflake}
                isOn={acOn}
                tone="sky"
                onToggle={() => toggleBool("input_boolean.bedroom_ac_power")}
              />
              <button
                type="button"
                aria-label={`${acMode}, switch AC mode to ${nextAcMode}`}
                onClick={() =>
                  onCallService("input_select", "select_option", {
                    entity_id: "input_select.bedroom_ac_mode",
                    option: nextAcMode,
                  })
                }
                className={`touch-target flex h-[54px] w-full items-center justify-between gap-2 rounded-2xl border px-3 text-xs font-medium transition-colors lg:px-4 lg:text-sm ${
                  acOn
                    ? "border-sky-400/35 bg-sky-400/15 text-sky-100 hover:bg-sky-400/20"
                    : "border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/[0.08]"
                }`}
              >
                <span className="truncate">{acMode}</span>
                <RefreshCw className="h-3.5 w-3.5 shrink-0 opacity-75" aria-hidden="true" />
              </button>
            </div>

            <div
              className={`flex h-[54px] items-center justify-between rounded-2xl border px-2 transition-colors ${
                acOn
                  ? "border-sky-400/25 bg-sky-400/[0.08] text-sky-100"
                  : "border-white/10 bg-white/[0.04] text-white/85"
              }`}
            >
              <button
                type="button"
                disabled={effectiveAcTemp <= MIN_AC_TEMP}
                aria-label="Decrease AC target temperature"
                onClick={() => stepAcTemp(-1)}
                className="touch-target flex h-12 w-12 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </button>
              <span className="text-base font-semibold tracking-tight tabular-nums lg:text-lg">
                {effectiveAcTemp}°C
              </span>
              <button
                type="button"
                disabled={effectiveAcTemp >= MAX_AC_TEMP}
                aria-label="Increase AC target temperature"
                onClick={() => stepAcTemp(1)}
                className="touch-target flex h-12 w-12 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Outlets (3fr) */}
          <div
            role="group"
            aria-label="Outlets"
            className="flex flex-col gap-2.5 md:pl-4 lg:pl-7"
          >
            <FixtureToggle
              label="Desk Plug"
              Icon={Plug}
              isOn={deskPlugOn}
              tone="emerald"
              onToggle={() => toggleBool("input_boolean.desk_plug")}
            />
            <FixtureToggle
              label="Standing Fan"
              Icon={Fan}
              isOn={fanPlugOn}
              tone="emerald"
              onToggle={() => toggleBool("input_boolean.fan_plug")}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
