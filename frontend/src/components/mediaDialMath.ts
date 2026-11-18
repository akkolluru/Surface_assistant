const BOUNDED_DIAL_MAX_COUNT = 3;
const BOUNDED_STEP_DEG = 42;
const MIN_CIRCULAR_STEP_DEG = 28;
const TARGET_ARC_SPAN_DEG = 200;
const RUBBER_BAND_DAMPING = 0.32;
const VISIBLE_ARC_LIMIT_DEG = 82;
const HIDDEN_ARC_LIMIT_DEG = 96;

/** Visibility, transform scale, and hit-test state for a single orbital dial slot. */
export interface SlotVisibility {
  opacity: number;
  scale: number;
  interactive: boolean;
  hidden: boolean;
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
