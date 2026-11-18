import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { MediaTileConfig } from "../types/hub";
import { MediaBrandLogo, getBrandTheme } from "./MediaBrandLogos";
import { createDialAudio, type DialAudioHandle } from "./dialAudio";
import {
  applyMagneticDetent,
  centerFocusWeight,
  clampDragContinuousIndex,
  computeStepDeg,
  defaultInitialIndex,
  isBoundedDial,
  normalizeAngleDeltaDeg,
  normalizeSignedOffset,
  pointerAngleDeg,
  shortestModularDelta,
  slotVisibility,
  stepCoastFrame,
  stepUnderdampedSpring,
  wrapTileIndex,
} from "./mediaDialMath";

/** Props accepted by the bedside {@link MediaLauncher} pane. */
export interface MediaLauncherProps {
  tiles: MediaTileConfig[];
  activeTileId: string | null;
  onLaunchTile: (tileId: string) => void;
  onCloseMedia?: () => void;
  onNavigateHub: () => void;
}

type DialStyleProperties = CSSProperties & {
  "--service-rgb": string;
  "--dial-r": string;
};

type AnimationMode = "idle" | "coast" | "spring";

interface VelocitySample {
  timeMs: number;
  pos: number;
}

interface ActiveDialDrag {
  pointerId: number;
  startX: number;
  startY: number;
  thresholdPx: number;
  lastAngleDeg: number;
  cumulativeAngleDeg: number;
  anchorContinuous: number;
  pivotCx: number;
  pivotCy: number;
  active: boolean;
  caughtCoast: boolean;
  samples: VelocitySample[];
}

interface BezelTick {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  major: boolean;
}

const DRAG_BUTTON_THRESHOLD_PX = 22;
const DRAG_TRACK_THRESHOLD_PX = 6;
const FALLBACK_ORBIT_PX = 220;
const COAST_HANDOFF_SPEED = 1.4;
const MAX_COAST_VELOCITY = 14;
const VELOCITY_WINDOW_MS = 90;
const STALE_PAUSE_MS = 85;
const MIN_VELOCITY_SPAN_SEC = 0.008;
const MAGNETIC_DETENT_STRENGTH = 0.28;
const SUB_TICKS_PER_SLOT = 5;
const SPRING_OMEGA = 24;
const SPRING_DAMPING_RATIO = 0.82;
const SPRING_SETTLE_EPSILON = 0.001;
const SPRING_VEL_SETTLE_EPSILON = 0.005;
const CLICK_SUPPRESS_TIMEOUT_MS = 150;
const DIAL_RADIUS_EXPR = "clamp(148px, min(24vw, calc(28vh - 44px)), 240px)";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function resolveDialPivot(
  stageEl: HTMLDivElement | null,
  clientX: number,
  clientY: number,
): { cx: number; cy: number } {
  const rect = stageEl?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.bottom,
    };
  }
  // In jsdom or unmeasured layouts (0×0 rect), derive a deterministic pivot
  // FALLBACK_ORBIT_PX below the pointer using the 2.78× / 1.46× stage geometry.
  const fallbackWidth = FALLBACK_ORBIT_PX * 2.78;
  const fallbackHeight = FALLBACK_ORBIT_PX * 1.46;
  const fallbackLeft = clientX - fallbackWidth / 2;
  const fallbackTop = clientY + FALLBACK_ORBIT_PX - fallbackHeight;
  return {
    cx: fallbackLeft + fallbackWidth / 2,
    cy: fallbackTop + fallbackHeight,
  };
}

function computeReleaseVelocity(samples: VelocitySample[], releaseTimeMs: number): number {
  if (prefersReducedMotion() || samples.length < 2) {
    return 0;
  }
  const newest = samples[samples.length - 1];
  const oldest = samples[0];
  if (!newest || !oldest) {
    return 0;
  }
  if (releaseTimeMs - newest.timeMs > STALE_PAUSE_MS) {
    return 0;
  }
  const dtSec = (newest.timeMs - oldest.timeMs) / 1000;
  if (dtSec < MIN_VELOCITY_SPAN_SEC) {
    return 0;
  }
  const rawVel = (newest.pos - oldest.pos) / dtSec;
  return Math.max(-MAX_COAST_VELOCITY, Math.min(MAX_COAST_VELOCITY, rawVel));
}

function EmptyMediaLauncher({ onNavigateHub }: Pick<MediaLauncherProps, "onNavigateHub">) {
  return (
    <section
      aria-label="Bedside Video Launcher"
      className="pane-item relative flex h-full w-full flex-col overflow-hidden bg-black text-white select-none"
    >
      <div className="pointer-events-none relative flex h-[58vh] w-full shrink-0 flex-col items-center justify-center px-6">
        <p className="text-lg font-medium tracking-tight text-white/60">
          No media apps configured
        </p>
      </div>

      <div className="relative flex h-[42vh] w-full shrink-0 items-end justify-center pt-4 pb-14">
        <button
          type="button"
          onClick={onNavigateHub}
          aria-label="Return to Ambient Hub"
          className="glass-panel touch-target absolute bottom-14 left-6 z-20 flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/15 hover:text-white md:left-8"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <span>Hub</span>
        </button>
      </div>
    </section>
  );
}

interface MediaDialLauncherProps extends MediaLauncherProps {
  tiles: MediaTileConfig[];
}

function MediaDialLauncher({
  tiles,
  activeTileId,
  onLaunchTile,
  onCloseMedia,
  onNavigateHub,
}: MediaDialLauncherProps) {
  const count = tiles.length;
  const stepDeg = computeStepDeg(count);
  const bounded = isBoundedDial(count);

  const planetClipId = useId();
  const planetGlowId = useId();

  const [selectedIndex, setSelectedIndex] = useState<number>(() => {
    if (activeTileId) {
      const activeIdx = tiles.findIndex((tile) => tile.id === activeTileId);
      if (activeIdx >= 0) {
        return activeIdx;
      }
    }
    return defaultInitialIndex(count);
  });

  const safeSelectedIndex = wrapTileIndex(selectedIndex, count);

  const dialStageRef = useRef<HTMLDivElement | null>(null);
  const bezelTicksRef = useRef<SVGGElement | null>(null);
  const reticleRef = useRef<SVGGElement | null>(null);
  const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const slotButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const continuousIndexRef = useRef<number>(safeSelectedIndex);
  const rawDragPosRef = useRef<number>(safeSelectedIndex);
  const targetContinuousRef = useRef<number>(safeSelectedIndex);
  const velocityRef = useRef<number>(0);
  const animationModeRef = useRef<AnimationMode>("idle");
  const isDraggingRef = useRef<boolean>(false);
  const lastFrameTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const dragStateRef = useRef<ActiveDialDrag | null>(null);
  const detachWindowListenersRef = useRef<() => void>(() => {});
  const dialSuppressClickRef = useRef<boolean>(false);
  const suppressTimerRef = useRef<number | null>(null);
  const keyboardNavRef = useRef<boolean>(false);
  const prevActiveTileIdRef = useRef<string | null>(activeTileId);

  const dialAudioRef = useRef<DialAudioHandle | null>(null);
  const userActivatedRef = useRef<boolean>(false);
  const lastDetentRef = useRef<number>(safeSelectedIndex);
  const lastSubTickRef = useRef<number>(safeSelectedIndex * SUB_TICKS_PER_SLOT);

  const getDialAudio = useCallback((): DialAudioHandle => {
    if (!dialAudioRef.current) {
      dialAudioRef.current = createDialAudio();
    }
    return dialAudioRef.current;
  }, []);

  const clearDialSuppressTimer = useCallback(() => {
    if (suppressTimerRef.current !== null) {
      window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, []);

  const stopAnimationLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    lastFrameTimeRef.current = null;
  }, []);

  const triggerReticlePulse = useCallback(() => {
    const reticle = reticleRef.current;
    if (!reticle || prefersReducedMotion()) {
      return;
    }
    reticle.classList.remove("reticle-pulse");
    // Flush layout/animation state so consecutive detents retrigger the CSS keyframe.
    void reticle.getBoundingClientRect();
    reticle.classList.add("reticle-pulse");
  }, []);

  const notifyMotionCues = useCallback(
    (continuousPos: number) => {
      const detentIdx = Math.round(continuousPos);
      const subTickIdx = Math.round(continuousPos * SUB_TICKS_PER_SLOT);

      if (!userActivatedRef.current) {
        lastDetentRef.current = detentIdx;
        lastSubTickRef.current = subTickIdx;
        return;
      }

      if (detentIdx !== lastDetentRef.current) {
        lastDetentRef.current = detentIdx;
        lastSubTickRef.current = subTickIdx;
        getDialAudio().play("detent");
        triggerReticlePulse();
        return;
      }

      if (subTickIdx !== lastSubTickRef.current) {
        lastSubTickRef.current = subTickIdx;
        const mod = ((subTickIdx % SUB_TICKS_PER_SLOT) + SUB_TICKS_PER_SLOT) % SUB_TICKS_PER_SLOT;
        if (mod !== 0) {
          getDialAudio().play("tick");
        }
      }
    },
    [getDialAudio, triggerReticlePulse],
  );

  const applyDialTransforms = useCallback(
    (continuous: number) => {
      if (bezelTicksRef.current && stepDeg > 0) {
        const wrappedSlotFrac = continuous - Math.floor(continuous);
        const tickAngleDeg = -(wrappedSlotFrac * stepDeg);
        bezelTicksRef.current.setAttribute("transform", `rotate(${tickAngleDeg.toFixed(3)})`);
      }

      for (let idx = 0; idx < count; idx += 1) {
        const slotEl = slotRefs.current[idx];
        if (!slotEl) continue;

        const offset = normalizeSignedOffset(idx, continuous, count);
        const angleDeg = offset * stepDeg;
        const angleRad = (angleDeg * Math.PI) / 180;
        const vis = slotVisibility(Math.abs(angleDeg));
        const focus = centerFocusWeight(Math.abs(angleDeg), stepDeg);
        const blendedScale = vis.scale * (0.96 + focus * 0.1);

        const sin = Math.sin(angleRad);
        const cos = Math.cos(angleRad);

        // Decouple polar transform onto this non-button wrapper so CSS button scale composes cleanly.
        slotEl.style.transform = `translate3d(calc(-50% + var(--dial-r) * ${sin.toFixed(5)}), calc(-50% - var(--dial-r) * ${cos.toFixed(5)}), 0) scale(${blendedScale.toFixed(4)})`;
        slotEl.style.opacity = vis.opacity.toFixed(3);
        slotEl.style.visibility = vis.hidden ? "hidden" : "visible";
        slotEl.style.pointerEvents = vis.interactive ? "auto" : "none";
        slotEl.style.zIndex = String(Math.round((180 - Math.min(180, Math.abs(angleDeg))) * 10));
      }
    },
    [count, stepDeg],
  );

  const stepAnimationRef = useRef<(timestamp: number) => void>(() => {});
  stepAnimationRef.current = (timestamp: number) => {
    if (isDraggingRef.current || animationModeRef.current === "idle") {
      stopAnimationLoop();
      return;
    }

    if (prefersReducedMotion()) {
      const target =
        animationModeRef.current === "coast"
          ? wrapTileIndex(Math.round(continuousIndexRef.current), count)
          : targetContinuousRef.current;
      continuousIndexRef.current = target;
      rawDragPosRef.current = target;
      velocityRef.current = 0;
      animationModeRef.current = "idle";
      notifyMotionCues(target);
      applyDialTransforms(target);
      stopAnimationLoop();
      return;
    }

    const prevTime = lastFrameTimeRef.current ?? timestamp;
    const dt = Math.min(0.05, Math.max(0.001, (timestamp - prevTime) / 1000));
    lastFrameTimeRef.current = timestamp;

    if (animationModeRef.current === "coast") {
      const res = stepCoastFrame(continuousIndexRef.current, velocityRef.current, dt, count);
      continuousIndexRef.current = res.position;
      rawDragPosRef.current = res.position;
      velocityRef.current = res.velocity;
      notifyMotionCues(res.position);
      applyDialTransforms(res.position);

      const liveNearest = wrapTileIndex(res.targetIndex, count);
      keyboardNavRef.current = false;
      setSelectedIndex((prev) => (prev === liveNearest ? prev : liveNearest));

      if (res.handoffToSpring) {
        targetContinuousRef.current = res.targetIndex;
        animationModeRef.current = "spring";
      }

      rafIdRef.current = window.requestAnimationFrame((nextTs) =>
        stepAnimationRef.current(nextTs),
      );
      return;
    }

    const target = targetContinuousRef.current;
    const res = stepUnderdampedSpring(
      continuousIndexRef.current - target,
      velocityRef.current,
      dt,
      SPRING_OMEGA,
      SPRING_DAMPING_RATIO,
    );

    if (res.settled) {
      continuousIndexRef.current = target;
      rawDragPosRef.current = target;
      velocityRef.current = 0;
      animationModeRef.current = "idle";
      notifyMotionCues(target);
      applyDialTransforms(target);
      stopAnimationLoop();
      return;
    }

    const nextPos = target + res.displacement;
    continuousIndexRef.current = nextPos;
    rawDragPosRef.current = nextPos;
    velocityRef.current = res.velocity;
    notifyMotionCues(nextPos);
    applyDialTransforms(nextPos);
    rafIdRef.current = window.requestAnimationFrame((nextTs) => stepAnimationRef.current(nextTs));
  };

  const startAnimationLoop = useCallback(() => {
    if (rafIdRef.current === null) {
      lastFrameTimeRef.current = null;
      rafIdRef.current = window.requestAnimationFrame((ts) => stepAnimationRef.current(ts));
    }
  }, []);

  const scheduleSpringFrame = useCallback(() => {
    const isSettled =
      Math.abs(targetContinuousRef.current - continuousIndexRef.current) < SPRING_SETTLE_EPSILON &&
      Math.abs(velocityRef.current) < SPRING_VEL_SETTLE_EPSILON;

    if (prefersReducedMotion() || isSettled) {
      stopAnimationLoop();
      continuousIndexRef.current = targetContinuousRef.current;
      rawDragPosRef.current = targetContinuousRef.current;
      velocityRef.current = 0;
      animationModeRef.current = "idle";
      notifyMotionCues(continuousIndexRef.current);
      applyDialTransforms(continuousIndexRef.current);
      return;
    }

    animationModeRef.current = "spring";
    startAnimationLoop();
  }, [applyDialTransforms, notifyMotionCues, startAnimationLoop, stopAnimationLoop]);

  // Keep latest dial metrics accessible to active window drag listeners without rebinding mid-gesture.
  const latestMetricsRef = useRef({
    count,
    stepDeg,
    applyDialTransforms,
    notifyMotionCues,
    scheduleSpringFrame,
    startAnimationLoop,
    stopAnimationLoop,
  });
  latestMetricsRef.current = {
    count,
    stepDeg,
    applyDialTransforms,
    notifyMotionCues,
    scheduleSpringFrame,
    startAnimationLoop,
    stopAnimationLoop,
  };

  // Clamp/wrap selection if the tile count shrinks dynamically.
  useEffect(() => {
    setSelectedIndex((prev) => {
      const next = wrapTileIndex(prev, count);
      if (next !== prev) {
        userActivatedRef.current = false;
      }
      return next === prev ? prev : next;
    });
  }, [count]);

  // Sync dial center only when activeTileId actually changes externally (silently).
  useEffect(() => {
    if (activeTileId === prevActiveTileIdRef.current) {
      return;
    }
    prevActiveTileIdRef.current = activeTileId;
    if (!activeTileId) {
      return;
    }
    const activeIdx = tiles.findIndex((tile) => tile.id === activeTileId);
    if (activeIdx >= 0) {
      userActivatedRef.current = false;
      keyboardNavRef.current = false;
      if (animationModeRef.current === "coast") {
        animationModeRef.current = "idle";
        velocityRef.current = 0;
      }
      setSelectedIndex(activeIdx);
    }
  }, [activeTileId, tiles]);

  // Synchronize slot transforms before first paint and whenever selection updates outside drag/coast.
  useLayoutEffect(() => {
    if (isDraggingRef.current || animationModeRef.current === "coast") {
      return;
    }
    if (
      animationModeRef.current === "spring" &&
      wrapTileIndex(Math.round(targetContinuousRef.current), count) === safeSelectedIndex
    ) {
      return;
    }
    const delta = shortestModularDelta(continuousIndexRef.current, safeSelectedIndex, count);
    targetContinuousRef.current = continuousIndexRef.current + delta;
    applyDialTransforms(continuousIndexRef.current);
    scheduleSpringFrame();
  }, [applyDialTransforms, count, safeSelectedIndex, scheduleSpringFrame]);

  // Shift focus to the active medallion only after keyboard navigation inside the dial group.
  useEffect(() => {
    if (!keyboardNavRef.current) {
      return;
    }
    keyboardNavRef.current = false;
    slotButtonRefs.current[safeSelectedIndex]?.focus();
  }, [safeSelectedIndex]);

  // Clean up rAF, window drag listeners, suppression timers, and Web Audio on unmount.
  useEffect(() => {
    return () => {
      stopAnimationLoop();
      detachWindowListenersRef.current();
      clearDialSuppressTimer();
      dialAudioRef.current?.dispose();
      dialAudioRef.current = null;
    };
  }, [clearDialSuppressTimer, stopAnimationLoop]);

  const bezelTicks = useMemo<BezelTick[]>(() => {
    if (stepDeg <= 0) {
      return [];
    }
    const minK = Math.floor(-95 / stepDeg);
    const maxK = Math.ceil((95 + stepDeg) / stepDeg);
    const ticks: BezelTick[] = [];

    for (let k = minK; k <= maxK; k += 1) {
      for (let m = 0; m < SUB_TICKS_PER_SLOT; m += 1) {
        const deg = (k + m / SUB_TICKS_PER_SLOT) * stepDeg;
        const rad = (deg * Math.PI) / 180;
        const major = m === 0;
        const innerR = major ? 301 : 306;
        const outerR = major ? 317 : 314;
        const sin = Math.sin(rad);
        const cos = Math.cos(rad);
        ticks.push({
          key: `${k}:${m}`,
          x1: Number((innerR * sin).toFixed(2)),
          y1: Number((-innerR * cos).toFixed(2)),
          x2: Number((outerR * sin).toFixed(2)),
          y2: Number((-outerR * cos).toFixed(2)),
          major,
        });
      }
    }
    return ticks;
  }, [stepDeg]);

  const handleDialPointerDown = (event: ReactPointerEvent<HTMLElement | SVGPathElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.isPrimary === false) return;
    if (dragStateRef.current !== null) return;

    getDialAudio().unlock();
    userActivatedRef.current = true;
    clearDialSuppressTimer();
    dialSuppressClickRef.current = false;

    const caughtCoast = animationModeRef.current === "coast";
    if (caughtCoast) {
      stopAnimationLoop();
      animationModeRef.current = "idle";
      velocityRef.current = 0;
      rawDragPosRef.current = continuousIndexRef.current;
    }

    const startedOnButton = Boolean((event.target as Element | null)?.closest("button"));
    const thresholdPx = startedOnButton ? DRAG_BUTTON_THRESHOLD_PX : DRAG_TRACK_THRESHOLD_PX;

    const pivot = resolveDialPivot(dialStageRef.current, event.clientX, event.clientY);
    const initialAngle = pointerAngleDeg(event.clientX, event.clientY, pivot.cx, pivot.cy);

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      thresholdPx,
      lastAngleDeg: initialAngle,
      cumulativeAngleDeg: 0,
      anchorContinuous: continuousIndexRef.current,
      pivotCx: pivot.cx,
      pivotCy: pivot.cy,
      active: false,
      caughtCoast,
      samples: [],
    };

    const finishDrag = (pointerId: number | null, canceled = false) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      if (pointerId !== null && drag.pointerId !== pointerId) return;

      detachWindowListenersRef.current();
      dragStateRef.current = null;
      isDraggingRef.current = false;

      if (!drag.active && !drag.caughtCoast) {
        return;
      }

      const {
        count: currentCount,
        scheduleSpringFrame: scheduleSpring,
        startAnimationLoop: startLoop,
      } = latestMetricsRef.current;

      dialSuppressClickRef.current = true;
      clearDialSuppressTimer();
      suppressTimerRef.current = window.setTimeout(() => {
        dialSuppressClickRef.current = false;
        suppressTimerRef.current = null;
      }, CLICK_SUPPRESS_TIMEOUT_MS);

      if (!drag.active && drag.caughtCoast) {
        const rawRounded = Math.round(continuousIndexRef.current);
        const target = isBoundedDial(currentCount)
          ? Math.min(currentCount - 1, Math.max(0, rawRounded))
          : rawRounded;
        const wrapped = wrapTileIndex(target, currentCount);

        keyboardNavRef.current = false;
        setSelectedIndex(wrapped);
        targetContinuousRef.current = target;
        velocityRef.current = 0;
        scheduleSpring();
        return;
      }

      const releaseVel = canceled ? 0 : computeReleaseVelocity(drag.samples, nowMs());

      if (Math.abs(releaseVel) >= COAST_HANDOFF_SPEED) {
        velocityRef.current = releaseVel;
        animationModeRef.current = "coast";
        startLoop();
        return;
      }

      const rawRounded = Math.round(rawDragPosRef.current);
      const target = isBoundedDial(currentCount)
        ? Math.min(currentCount - 1, Math.max(0, rawRounded))
        : rawRounded;
      const wrapped = wrapTileIndex(target, currentCount);

      keyboardNavRef.current = false;
      setSelectedIndex(wrapped);
      targetContinuousRef.current = target;
      velocityRef.current = releaseVel;
      scheduleSpring();
    };

    const onWindowPointerMove = (moveEvent: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;

      const timestamp = nowMs();
      const currentAngle = pointerAngleDeg(
        moveEvent.clientX,
        moveEvent.clientY,
        drag.pivotCx,
        drag.pivotCy,
      );

      if (!drag.active) {
        const dist = Math.hypot(
          moveEvent.clientX - drag.startX,
          moveEvent.clientY - drag.startY,
        );
        if (dist < drag.thresholdPx) {
          drag.lastAngleDeg = currentAngle;
          return;
        }

        // Engage seamlessly from the threshold boundary so there is zero sudden angle snap.
        const engageRatio = drag.thresholdPx / dist;
        const engageX = drag.startX + (moveEvent.clientX - drag.startX) * engageRatio;
        const engageY = drag.startY + (moveEvent.clientY - drag.startY) * engageRatio;
        const engageAngle = pointerAngleDeg(engageX, engageY, drag.pivotCx, drag.pivotCy);

        drag.active = true;
        isDraggingRef.current = true;
        dialSuppressClickRef.current = true;
        velocityRef.current = 0;
        animationModeRef.current = "idle";
        latestMetricsRef.current.stopAnimationLoop();

        drag.anchorContinuous = continuousIndexRef.current;
        rawDragPosRef.current = continuousIndexRef.current;
        drag.lastAngleDeg = engageAngle;
        drag.cumulativeAngleDeg = 0;
        drag.samples = [{ timeMs: timestamp, pos: continuousIndexRef.current }];
      }

      const stepDelta = normalizeAngleDeltaDeg(currentAngle - drag.lastAngleDeg);
      drag.lastAngleDeg = currentAngle;
      drag.cumulativeAngleDeg += stepDelta;

      const {
        count: currentCount,
        stepDeg: currentStepDeg,
        applyDialTransforms: applyTransforms,
        notifyMotionCues: notifyCues,
      } = latestMetricsRef.current;

      if (currentStepDeg <= 0) return;

      const rawTarget = drag.anchorContinuous - drag.cumulativeAngleDeg / currentStepDeg;
      const dampedRaw = clampDragContinuousIndex(rawTarget, currentCount);
      rawDragPosRef.current = dampedRaw;

      const visualPos = applyMagneticDetent(dampedRaw, currentCount, MAGNETIC_DETENT_STRENGTH);
      continuousIndexRef.current = visualPos;
      targetContinuousRef.current = visualPos;

      drag.samples.push({ timeMs: timestamp, pos: dampedRaw });
      while (drag.samples.length > 1) {
        const oldest = drag.samples[0];
        if (!oldest || timestamp - oldest.timeMs <= VELOCITY_WINDOW_MS) {
          break;
        }
        drag.samples.shift();
      }

      notifyCues(visualPos);
      applyTransforms(visualPos);

      const nearest = wrapTileIndex(Math.round(dampedRaw), currentCount);
      keyboardNavRef.current = false;
      setSelectedIndex((prev) => (prev === nearest ? prev : nearest));
    };

    const onWindowPointerUp = (upEvent: PointerEvent) => {
      finishDrag(upEvent.pointerId, false);
    };

    const onWindowPointerCancel = (cancelEvent: PointerEvent) => {
      finishDrag(cancelEvent.pointerId, true);
    };

    const onWindowBlur = () => {
      finishDrag(null, true);
    };

    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    window.addEventListener("blur", onWindowBlur);

    detachWindowListenersRef.current = () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      detachWindowListenersRef.current = () => {};
    };
  };

  const handleDialClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dialSuppressClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearDialSuppressTimer();
    dialSuppressClickRef.current = false;
  };

  const handleSlotClick = (idx: number) => {
    if (dialSuppressClickRef.current) {
      return;
    }
    const tile = tiles[idx];
    if (!tile) {
      return;
    }
    getDialAudio().unlock();
    if (idx === safeSelectedIndex) {
      onLaunchTile(tile.id);
      return;
    }
    userActivatedRef.current = true;
    keyboardNavRef.current = false;
    animationModeRef.current = "idle";
    setSelectedIndex(idx);
  };

  const cycleSelection = (delta: number) => {
    getDialAudio().unlock();
    const next = wrapTileIndex(safeSelectedIndex + delta, count);
    if (next === safeSelectedIndex) {
      return;
    }
    userActivatedRef.current = true;
    keyboardNavRef.current = false;
    animationModeRef.current = "idle";
    setSelectedIndex(next);
  };

  const handleDialKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = wrapTileIndex(safeSelectedIndex - 1, count);
        break;
      case "ArrowRight":
        nextIndex = wrapTileIndex(safeSelectedIndex + 1, count);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    getDialAudio().unlock();
    if (nextIndex !== safeSelectedIndex) {
      userActivatedRef.current = true;
      keyboardNavRef.current = true;
      animationModeRef.current = "idle";
      setSelectedIndex(nextIndex);
    }
  };

  const selectedTile = tiles[safeSelectedIndex] ?? tiles[0];
  if (!selectedTile) {
    return null;
  }

  const selectedTheme = getBrandTheme(selectedTile.id);
  const isSelectedRunning = activeTileId === selectedTile.id;
  const runningTile = activeTileId
    ? tiles.find((tile) => tile.id === activeTileId) ?? null
    : null;
  const runningTileLabel = runningTile?.label ?? activeTileId;
  const leftDisabled = bounded && safeSelectedIndex === 0;
  const rightDisabled = bounded && safeSelectedIndex === count - 1;

  const sectionStyle: DialStyleProperties = {
    "--service-rgb": selectedTheme.rgb,
    "--dial-r": DIAL_RADIUS_EXPR,
  };

  return (
    <section
      aria-label="Bedside Video Launcher"
      style={sectionStyle}
      className="pane-item relative flex h-full w-full flex-col overflow-hidden bg-black text-white select-none"
    >
      {/* Upper Non-Interactive Hologram Projection Zone */}
      <div className="pointer-events-none relative flex h-[58vh] w-full shrink-0 flex-col items-center justify-center px-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-opacity duration-300 ease-out motion-reduce:transition-none motion-reduce:duration-[1ms]"
          style={{
            background:
              "radial-gradient(62% 58% at 50% 98%, rgba(var(--service-rgb), 0.24) 0%, rgba(var(--service-rgb), 0.08) 44%, rgba(0, 0, 0, 0) 78%)",
          }}
        />

        <div className="relative z-10 flex flex-col items-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 rounded-full border transition-[border-color] duration-300 ease-out motion-reduce:transition-none motion-reduce:duration-[1ms]"
            style={{
              width: "clamp(132px, 19vh, 188px)",
              height: "clamp(132px, 19vh, 188px)",
              borderColor: "rgba(var(--service-rgb), 0.14)",
              background:
                "radial-gradient(circle at 50% 50%, rgba(var(--service-rgb), 0.12) 0%, rgba(var(--service-rgb), 0.03) 56%, rgba(0, 0, 0, 0) 76%)",
            }}
          />

          <div key={selectedTile.id} className="hologram-enter relative flex flex-col items-center">
            <div
              className="flex items-center justify-center"
              style={{
                width: "clamp(132px, 19vh, 188px)",
                height: "clamp(132px, 19vh, 188px)",
              }}
            >
              <MediaBrandLogo
                tileId={selectedTile.id}
                variant="hologram"
                className="h-[clamp(72px,10vh,104px)] w-[clamp(72px,10vh,104px)]"
              />
            </div>

            <h2 className="mt-5 text-center text-[clamp(1.75rem,3.6vh,2.75rem)] font-semibold tracking-tight text-white [text-wrap:balance]">
              {selectedTile.label}
            </h2>
          </div>

          {isSelectedRunning && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/35 bg-emerald-500/15 px-3.5 py-1 text-xs font-semibold tracking-wide text-emerald-200">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-400" />
              <span>Now Playing</span>
            </div>
          )}
        </div>
      </div>

      {/* Lower Interactive Touch Deck */}
      <div className="relative flex h-[42vh] w-full shrink-0 items-end justify-center pt-4 pb-14">
        <p className="sr-only" aria-live="polite">
          {selectedTile.label}
          {isSelectedRunning ? ", Now Playing" : ""}
        </p>

        {/* Return to Ambient Hub Pill */}
        <button
          type="button"
          onClick={onNavigateHub}
          aria-label="Return to Ambient Hub"
          className="glass-panel touch-target absolute bottom-14 left-6 z-20 flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/15 hover:text-white md:left-8"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <span>Hub</span>
        </button>

        {/* Close Active Media App Pill */}
        {activeTileId !== null && runningTileLabel && onCloseMedia && (
          <button
            type="button"
            onClick={onCloseMedia}
            data-testid="close-media-button"
            aria-label={`Close running ${runningTileLabel}`}
            className="glass-panel touch-target absolute right-6 bottom-14 z-20 flex min-h-[44px] items-center gap-1.5 rounded-full border-rose-400/30 px-4 py-2 text-sm font-medium text-rose-100 hover:bg-rose-500/20 hover:text-white md:right-8"
          >
            <X className="h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
            <span>Close {runningTileLabel}</span>
          </button>
        )}

        {/* Ghost Flanking Chevrons */}
        <button
          type="button"
          onClick={() => cycleSelection(-1)}
          disabled={leftDisabled}
          aria-label="Previous media service"
          style={{ left: "calc(50% - min(var(--dial-r) * 1.48, 40vw))" }}
          className={`touch-target absolute bottom-14 z-20 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full text-white/45 hover:text-white/90 active:text-white ${
            leftDisabled ? "pointer-events-none opacity-20" : ""
          }`}
        >
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => cycleSelection(1)}
          disabled={rightDisabled}
          aria-label="Next media service"
          style={{ left: "calc(50% + min(var(--dial-r) * 1.48, 40vw))" }}
          className={`touch-target absolute bottom-14 z-20 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full text-white/45 hover:text-white/90 active:text-white ${
            rightDisabled ? "pointer-events-none opacity-20" : ""
          }`}
        >
          <ChevronRight className="h-6 w-6" aria-hidden="true" />
        </button>

        {/* Orbital Dial Stage (pointer-events-none outer wrapper preserves horizontal pane swipes) */}
        <div
          ref={dialStageRef}
          onClickCapture={handleDialClickCapture}
          className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 overflow-hidden"
          style={{
            width: "calc(var(--dial-r) * 2.78)",
            height: "calc(var(--dial-r) * 1.46)",
          }}
        >
          {/* Semi-Circular Track + Planetary Hollow Core + Rotating Bezel Ticks + Scrub Surface */}
          <svg
            viewBox="-330 -330 660 330"
            className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2"
            style={{
              width: "calc(var(--dial-r) * 660 / 237.5)",
              height: "calc(var(--dial-r) * 330 / 237.5)",
            }}
          >
            <defs>
              <clipPath id={planetClipId}>
                <path d="M -132 0 A 132 132 0 0 1 132 0 Z" />
              </clipPath>
              <radialGradient id={planetGlowId} cx="50%" cy="15%" r="85%">
                <stop offset="0%" stopColor="rgb(var(--service-rgb))" stopOpacity="0.16" />
                <stop offset="65%" stopColor="rgb(var(--service-rgb))" stopOpacity="0.04" />
                <stop offset="100%" stopColor="#000000" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Whisper-faint planetary core inside R < 138 (100% non-interactive) */}
            <g aria-hidden="true" opacity="0.9">
              <circle
                cx="0"
                cy="0"
                r="132"
                fill={`url(#${planetGlowId})`}
                clipPath={`url(#${planetClipId})`}
              />
              <g clipPath={`url(#${planetClipId})`}>
                <path
                  d="M -124 -46 Q 0 -30 124 -46"
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.085)"
                  strokeWidth="0.9"
                />
                <path
                  d="M -95 -92 Q 0 -78 95 -92"
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.075)"
                  strokeWidth="0.9"
                />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="-132"
                  stroke="rgba(255, 255, 255, 0.07)"
                  strokeWidth="0.85"
                />
                <path
                  d="M 0 -132 Q -78 -68 -66 0"
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.085)"
                  strokeWidth="0.9"
                />
                <path
                  d="M 0 -132 Q 78 -68 66 0"
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.085)"
                  strokeWidth="0.9"
                />
              </g>
              <path
                d="M -132 0 A 132 132 0 0 1 132 0"
                fill="none"
                stroke="rgba(255, 255, 255, 0.12)"
                strokeWidth="1"
              />
              <path
                d="M -136 0 A 136 136 0 0 1 136 0"
                fill="none"
                stroke="rgba(var(--service-rgb), 0.15)"
                strokeWidth="1.1"
              />
            </g>

            {/* Hairline Outer & Inner Track Arcs */}
            <path
              aria-hidden="true"
              d="M -320 0 A 320 320 0 0 1 320 0"
              fill="none"
              stroke="rgba(255, 255, 255, 0.08)"
              strokeWidth="1"
            />
            <path
              aria-hidden="true"
              d="M -155 0 A 155 155 0 0 1 155 0"
              fill="none"
              stroke="rgba(255, 255, 255, 0.11)"
              strokeWidth="1"
            />

            {/* Rotating Bezel Tick Ring */}
            <g ref={bezelTicksRef} aria-hidden="true">
              {bezelTicks.map((tick) => (
                <line
                  key={tick.key}
                  x1={tick.x1}
                  y1={tick.y1}
                  x2={tick.x2}
                  y2={tick.y2}
                  stroke={
                    tick.major
                      ? "rgba(255, 255, 255, 0.34)"
                      : "rgba(255, 255, 255, 0.16)"
                  }
                  strokeWidth={tick.major ? 1.6 : 1.1}
                  strokeLinecap="round"
                />
              ))}
            </g>

            {/* Top 0° Selection Reticle Pip (pulses on detent crossings) */}
            <g ref={reticleRef} aria-hidden="true">
              <line
                x1="0"
                y1="-326"
                x2="0"
                y2="-319"
                stroke="rgba(var(--service-rgb), 0.85)"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="0" cy="-315" r="2" fill="rgba(var(--service-rgb), 0.78)" />
            </g>

            {/* Widened Invisible Annular Scrub Surface (R = 138..330) */}
            <path
              data-dial-ring="true"
              d="M -234 0 A 234 234 0 0 1 234 0"
              fill="none"
              stroke="transparent"
              strokeWidth={192}
              strokeLinecap="butt"
              style={{ pointerEvents: "stroke" }}
              aria-hidden="true"
              onPointerDown={handleDialPointerDown}
            />
          </svg>

          {/* Orbital Medallions */}
          <div
            role="group"
            aria-label="Media service dial"
            onKeyDown={handleDialKeyDown}
            className="pointer-events-none absolute inset-0"
          >
            {tiles.map((tile, idx) => {
              const isSelected = idx === safeSelectedIndex;
              const isRunning = activeTileId === tile.id;
              const theme = getBrandTheme(tile.id);

              const ariaLabel = isSelected
                ? isRunning
                  ? `Resume ${tile.label}`
                  : `Launch ${tile.label}`
                : isRunning
                  ? `Select ${tile.label} (currently playing)`
                  : `Select ${tile.label}`;

              return (
                <div
                  key={tile.id}
                  ref={(el) => {
                    slotRefs.current[idx] = el;
                  }}
                  className="absolute top-full left-1/2 will-change-transform"
                >
                  <button
                    ref={(el) => {
                      slotButtonRefs.current[idx] = el;
                    }}
                    type="button"
                    data-dial-ring="true"
                    tabIndex={isSelected ? 0 : -1}
                    aria-current={isSelected ? "true" : undefined}
                    aria-label={ariaLabel}
                    onPointerDown={handleDialPointerDown}
                    onClick={() => handleSlotClick(idx)}
                    style={
                      isSelected
                        ? {
                            boxShadow: `0 0 28px -6px rgba(${theme.rgb}, 0.42)`,
                          }
                        : undefined
                    }
                    className={`touch-target relative flex items-center justify-center rounded-full border backdrop-blur-xl ${
                      isSelected
                        ? `h-[clamp(64px,calc(var(--dial-r)*0.35),84px)] w-[clamp(64px,calc(var(--dial-r)*0.35),84px)] bg-zinc-950/90 ring-2 ${theme.ringClass}`
                        : "h-[clamp(48px,calc(var(--dial-r)*0.27),64px)] w-[clamp(48px,calc(var(--dial-r)*0.27),64px)] border-white/15 bg-zinc-950/75 hover:border-white/30 hover:bg-zinc-900/85"
                    }`}
                  >
                    <MediaBrandLogo
                      tileId={tile.id}
                      variant="dial"
                      className={isSelected ? "h-8 w-8" : "h-6 w-6"}
                    />

                    {isRunning && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]"
                      />
                    )}

                    {isSelected ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-2.5 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-zinc-950/95 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-white/90 uppercase shadow-md"
                      >
                        {isRunning ? "Resume" : "Watch"}
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-1.5 left-1/2 max-w-full -translate-x-1/2 truncate rounded-full border border-white/15 bg-zinc-950/90 px-1 py-[1px] text-[9px] leading-tight font-medium tracking-wide text-white/80 shadow-sm"
                      >
                        {tile.label}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Bedside Video Launcher pane presenting a calm obsidian upper hologram stage
 * controlled by an interactive orbital dial touch deck below.
 */
export function MediaLauncher({
  tiles,
  activeTileId,
  onLaunchTile,
  onCloseMedia,
  onNavigateHub,
}: MediaLauncherProps) {
  if (tiles.length === 0) {
    return <EmptyMediaLauncher onNavigateHub={onNavigateHub} />;
  }

  return (
    <MediaDialLauncher
      tiles={tiles}
      activeTileId={activeTileId}
      onLaunchTile={onLaunchTile}
      onCloseMedia={onCloseMedia}
      onNavigateHub={onNavigateHub}
    />
  );
}
