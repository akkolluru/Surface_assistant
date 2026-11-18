const BOUNDED_DIAL_MAX_COUNT = 3;
const BOUNDED_STEP_DEG = 42;
const MIN_CIRCULAR_STEP_DEG = 28;
const TARGET_ARC_SPAN_DEG = 200;
const RUBBER_BAND_DAMPING = 0.32;
const VISIBLE_ARC_LIMIT_DEG = 82;
const HIDDEN_ARC_LIMIT_DEG = 96;
const DEFAULT_MAGNETIC_STRENGTH = 0.28;
const MAX_MAGNETIC_STRENGTH = 0.6;
const COAST_FRICTION = 5.2;
const COAST_HANDOFF_SPEED = 1.4;
const COAST_LOOKAHEAD_SEC = 0.08;
const MAX_PHYSICS_DT_SEC = 0.05;
const SPRING_SETTLE_DISP_EPSILON = 0.001;
const SPRING_SETTLE_VEL_EPSILON = 0.005;

/** Visibility, transform scale, and hit-test state for a single orbital dial slot. */
export interface SlotVisibility {
  opacity: number;
  scale: number;
  interactive: boolean;
  hidden: boolean;
}

/** Output of one inertial coasting integration step. */
export interface CoastFrameResult {
  position: number;
  velocity: number;
  handoffToSpring: boolean;
  targetIndex: number;
}

/** Output of one closed-form underdamped spring integration step. */
export interface UnderdampedSpringResult {
  displacement: number;
  velocity: number;
  settled: boolean;
}

/**
 * Returns true when the tile set is small enough (`<= 3`) to render as a
 * bounded non-wrapping arc rather than a continuous circular ring.
 */
export function isBoundedDial(count: number): boolean {
  return count <= BOUNDED_DIAL_MAX_COUNT;
}

/**
 * Computes the angular spacing (in degrees) between adjacent dial slots.
 */
export function computeStepDeg(count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  if (isBoundedDial(count)) {
    return BOUNDED_STEP_DEG;
  }
  return Math.max(MIN_CIRCULAR_STEP_DEG, Math.ceil(TARGET_ARC_SPAN_DEG / count));
}

/**
 * Selects the default centered tile index for initial dial mount.
 */
export function defaultInitialIndex(count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  if (isBoundedDial(count)) {
    return Math.floor(count / 2);
  }
  return 0;
}

/**
 * Computes the signed slot offset of `index` relative to `continuousIndex`.
 * For circular dials (`count >= 4`), wraps cleanly into `[-0.5 * count, +0.5 * count)`.
 */
export function normalizeSignedOffset(
  index: number,
  continuousIndex: number,
  count: number,
): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  const diff = index - continuousIndex;
  if (isBoundedDial(count)) {
    return diff;
  }
  const normalized = (((diff % count) + 1.5 * count) % count) - 0.5 * count;
  return normalized === 0 ? 0 : normalized;
}

/**
 * Returns the shortest signed step delta from `from` to `to` in slot units.
 */
export function shortestModularDelta(from: number, to: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  const diff = to - from;
  if (isBoundedDial(count)) {
    return diff;
  }
  const normalized = ((((diff + 0.5 * count) % count) + count) % count) - 0.5 * count;
  return normalized === 0 ? 0 : normalized;
}

/**
 * Resolves an arbitrary integer slot index to a valid tile index in `[0, count - 1]`.
 * Bounded dials clamp at the ends; circular dials wrap modularly.
 */
export function wrapTileIndex(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  if (isBoundedDial(count)) {
    return Math.min(count - 1, Math.max(0, index));
  }
  const wrapped = ((index % count) + count) % count;
  return wrapped === 0 ? 0 : wrapped;
}

/**
 * Applies `0.32×` rubber-band damping past the ends of bounded dials (`count <= 3`),
 * while allowing continuous wrap-around drag for circular dials.
 */
export function clampDragContinuousIndex(targetIndex: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  if (!isBoundedDial(count)) {
    return targetIndex;
  }
  const maxIndex = count - 1;
  if (targetIndex < 0) {
    return targetIndex * RUBBER_BAND_DAMPING;
  }
  if (targetIndex > maxIndex) {
    return maxIndex + (targetIndex - maxIndex) * RUBBER_BAND_DAMPING;
  }
  return targetIndex;
}

/**
 * Computes progressive opacity, scale, and interactivity along the orbital arc,
 * fading slots smoothly to invisible beyond `96°`.
 */
export function slotVisibility(absAngleDeg: number): SlotVisibility {
  if (!Number.isFinite(absAngleDeg)) {
    return { opacity: 0, scale: 0.62, interactive: false, hidden: true };
  }
  const angle = Math.abs(absAngleDeg);
  if (angle <= VISIBLE_ARC_LIMIT_DEG) {
    const ratio = angle / VISIBLE_ARC_LIMIT_DEG;
    return {
      opacity: Math.max(0.68, 1 - ratio * 0.32),
      scale: Math.max(0.78, 1 - ratio * 0.2),
      interactive: true,
      hidden: false,
    };
  }
  if (angle < HIDDEN_ARC_LIMIT_DEG) {
    const t = (angle - VISIBLE_ARC_LIMIT_DEG) / (HIDDEN_ARC_LIMIT_DEG - VISIBLE_ARC_LIMIT_DEG);
    return {
      opacity: 0.68 * (1 - t),
      scale: 0.78 - 0.16 * t,
      interactive: false,
      hidden: false,
    };
  }
  return { opacity: 0, scale: 0.62, interactive: false, hidden: true };
}

/**
 * Returns the pointer angle in degrees relative to `(centerX, centerY)`,
 * where `0°` points straight up (12 o'clock), negative is left, and positive is right.
 */
export function pointerAngleDeg(
  clientX: number,
  clientY: number,
  centerX: number,
  centerY: number,
): number {
  return (Math.atan2(clientX - centerX, centerY - clientY) * 180) / Math.PI;
}

/**
 * Wraps an angular delta into `[-180, 180]` so pointer drags across the
 * `±180°` seam stay continuous without sudden jumps.
 */
export function normalizeAngleDeltaDeg(deltaDeg: number): number {
  if (!Number.isFinite(deltaDeg)) {
    return 0;
  }
  if (deltaDeg === -180) {
    return -180;
  }
  const wrapped = ((deltaDeg % 360) + 360) % 360;
  const normalized = wrapped > 180 ? wrapped - 360 : wrapped;
  return normalized === 0 ? 0 : normalized;
}

/**
 * Applies a subtle magnetic detent warp toward nearest integer slot centers,
 * while leaving bounded edge rubber-banding unmodified for smooth end stops.
 */
export function applyMagneticDetent(
  continuousIndex: number,
  count: number,
  strength = DEFAULT_MAGNETIC_STRENGTH,
): number {
  if (!Number.isFinite(continuousIndex) || !Number.isFinite(count) || count <= 0) {
    return 0;
  }
  if (isBoundedDial(count) && (continuousIndex <= 0 || continuousIndex >= count - 1)) {
    return continuousIndex === 0 ? 0 : continuousIndex;
  }
  const k = Number.isFinite(strength)
    ? Math.max(0, Math.min(MAX_MAGNETIC_STRENGTH, strength))
    : DEFAULT_MAGNETIC_STRENGTH;
  const warped = continuousIndex - (k / (2 * Math.PI)) * Math.sin(2 * Math.PI * continuousIndex);
  return warped === 0 ? 0 : warped;
}

/**
 * Smoothstep weight from `1` at `0°` center to `0` at `±stepDeg` for continuous
 * focal emphasis (scale/brightness) during dial rotation.
 */
export function centerFocusWeight(absAngleDeg: number, stepDeg: number): number {
  if (!Number.isFinite(absAngleDeg) || !Number.isFinite(stepDeg) || stepDeg <= 0) {
    return 0;
  }
  const t = Math.max(0, Math.min(1, 1 - Math.abs(absAngleDeg) / stepDeg));
  return t * t * (3 - 2 * t);
}

/**
 * Integrates one inertial coasting frame with exponential friction decay and
 * triggers handoff to the magnetic snap spring once speed falls below threshold
 * or a bounded dial hits an end stop.
 */
export function stepCoastFrame(
  position: number,
  velocity: number,
  dtSec: number,
  count: number,
): CoastFrameResult {
  if (
    !Number.isFinite(position) ||
    !Number.isFinite(velocity) ||
    !Number.isFinite(dtSec) ||
    !Number.isFinite(count) ||
    count <= 0
  ) {
    return { position: 0, velocity: 0, handoffToSpring: true, targetIndex: 0 };
  }

  const dt = Math.min(MAX_PHYSICS_DT_SEC, Math.max(0, dtSec));
  const nextVel = velocity * Math.exp(-COAST_FRICTION * dt);
  const nextPos = position + (velocity + nextVel) * 0.5 * dt;

  if (isBoundedDial(count)) {
    const maxIndex = count - 1;
    if (nextPos <= 0 || nextPos >= maxIndex) {
      const clampedPos = nextPos <= 0 ? 0 : maxIndex;
      const targetIndex = nextPos <= 0 ? 0 : maxIndex;
      return {
        position: clampedPos,
        velocity: nextVel === 0 ? 0 : nextVel,
        handoffToSpring: true,
        targetIndex,
      };
    }
  }

  if (Math.abs(nextVel) < COAST_HANDOFF_SPEED) {
    const rawTarget = Math.round(nextPos + nextVel * COAST_LOOKAHEAD_SEC);
    const boundedTarget = isBoundedDial(count)
      ? Math.min(count - 1, Math.max(0, rawTarget))
      : rawTarget;
    return {
      position: nextPos === 0 ? 0 : nextPos,
      velocity: nextVel === 0 ? 0 : nextVel,
      handoffToSpring: true,
      targetIndex: boundedTarget === 0 ? 0 : boundedTarget,
    };
  }

  const nearest = Math.round(nextPos);
  return {
    position: nextPos === 0 ? 0 : nextPos,
    velocity: nextVel === 0 ? 0 : nextVel,
    handoffToSpring: false,
    targetIndex: nearest === 0 ? 0 : nearest,
  };
}

/**
 * Closed-form underdamped harmonic oscillator step (`zeta = 0.82` gives ~1.1%
 * crisp magnetic settle) guaranteed unconditionally stable for any frame delta.
 */
export function stepUnderdampedSpring(
  displacement: number,
  velocity: number,
  dtSec: number,
  omega = 24,
  dampingRatio = 0.82,
): UnderdampedSpringResult {
  if (!Number.isFinite(displacement) || !Number.isFinite(velocity)) {
    return { displacement: 0, velocity: 0, settled: true };
  }

  const dt = Number.isFinite(dtSec) ? Math.min(MAX_PHYSICS_DT_SEC, Math.max(0, dtSec)) : 0;
  const safeOmega = Number.isFinite(omega) && omega > 0 ? omega : 24;
  const zeta = Number.isFinite(dampingRatio)
    ? Math.max(0.05, Math.min(0.999, dampingRatio))
    : 0.82;

  const omegaD = safeOmega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * safeOmega * dt);
  const cosTerm = Math.cos(omegaD * dt);
  const sinTerm = Math.sin(omegaD * dt);

  const b = (velocity + zeta * safeOmega * displacement) / omegaD;
  const nextDisp = decay * (displacement * cosTerm + b * sinTerm);
  const nextVel =
    decay *
    (velocity * cosTerm -
      ((zeta * safeOmega * velocity + safeOmega * safeOmega * displacement) / omegaD) * sinTerm);

  if (
    Math.abs(nextDisp) < SPRING_SETTLE_DISP_EPSILON &&
    Math.abs(nextVel) < SPRING_SETTLE_VEL_EPSILON
  ) {
    return { displacement: 0, velocity: 0, settled: true };
  }

  return {
    displacement: nextDisp === 0 ? 0 : nextDisp,
    velocity: nextVel === 0 ? 0 : nextVel,
    settled: false,
  };
}
