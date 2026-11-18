import { describe, expect, it } from "vitest";
import {
  clampDragContinuousIndex,
  computeStepDeg,
  defaultInitialIndex,
  isBoundedDial,
  normalizeAngleDeltaDeg,
  normalizeSignedOffset,
  pointerAngleDeg,
  shortestModularDelta,
  slotVisibility,
  wrapTileIndex,
} from "../components/mediaDialMath";

describe("mediaDialMath", () => {
  it("detects bounded vs circular dial sizes", () => {
    expect(isBoundedDial(0)).toBe(true);
    expect(isBoundedDial(1)).toBe(true);
    expect(isBoundedDial(3)).toBe(true);
    expect(isBoundedDial(4)).toBe(false);
    expect(isBoundedDial(5)).toBe(false);
    expect(isBoundedDial(8)).toBe(false);
  });

  it("computes angular step spacing across empty, bounded, and circular counts", () => {
    expect(computeStepDeg(0)).toBe(0);
    expect(computeStepDeg(-2)).toBe(0);
    expect(computeStepDeg(1)).toBe(42);
    expect(computeStepDeg(2)).toBe(42);
    expect(computeStepDeg(3)).toBe(42);
    expect(computeStepDeg(4)).toBe(50);
    expect(computeStepDeg(5)).toBe(40);
    expect(computeStepDeg(6)).toBe(34);
    expect(computeStepDeg(7)).toBe(29);
    expect(computeStepDeg(8)).toBe(28);
    expect(computeStepDeg(10)).toBe(28);
  });

  it("picks centered default index for bounded dials and 0 otherwise", () => {
    expect(defaultInitialIndex(0)).toBe(0);
    expect(defaultInitialIndex(1)).toBe(0);
    expect(defaultInitialIndex(2)).toBe(1);
    expect(defaultInitialIndex(3)).toBe(1);
    expect(defaultInitialIndex(4)).toBe(0);
    expect(defaultInitialIndex(5)).toBe(0);
    expect(defaultInitialIndex(8)).toBe(0);
  });

  it("normalizes signed offsets and shortest modular deltas across wrap seams", () => {
    expect(normalizeSignedOffset(2, 1, 0)).toBe(0);
    expect(shortestModularDelta(0, 2, 0)).toBe(0);

    // Bounded N = 3 keeps direct linear differences
    expect(normalizeSignedOffset(0, 1, 3)).toBe(-1);
    expect(normalizeSignedOffset(2, 1, 3)).toBe(1);
    expect(shortestModularDelta(0, 2, 3)).toBe(2);
    expect(shortestModularDelta(2, 0, 3)).toBe(-2);

    // Circular N = 4 wraps into [-2, +2)
    expect(normalizeSignedOffset(3, 0, 4)).toBe(-1);
    expect(normalizeSignedOffset(2, 0, 4)).toBe(-2);
    expect(normalizeSignedOffset(2, 0.25, 4)).toBeCloseTo(1.75);
    expect(shortestModularDelta(0, 3, 4)).toBe(-1);
    expect(shortestModularDelta(3, 0, 4)).toBe(1);

    // Circular N = 5 wraps into [-2.5, +2.5)
    expect(normalizeSignedOffset(4, 0, 5)).toBe(-1);
    expect(normalizeSignedOffset(0, 4.2, 5)).toBeCloseTo(0.8);
    expect(shortestModularDelta(0, 4, 5)).toBe(-1);
    expect(shortestModularDelta(4.8, 0, 5)).toBeCloseTo(0.2);

    // Circular N = 6 wraps into [-3, +3)
    expect(normalizeSignedOffset(5, 0, 6)).toBe(-1);
    expect(normalizeSignedOffset(0, 5, 6)).toBe(1);
    expect(normalizeSignedOffset(3, 0, 6)).toBe(-3);
    expect(shortestModularDelta(5, 1, 6)).toBe(2);
    expect(shortestModularDelta(0, 5, 6)).toBe(-1);
  });

  it("wraps or clamps integer tile indices based on dial mode", () => {
    expect(wrapTileIndex(2, 0)).toBe(0);
    expect(wrapTileIndex(-1, 3)).toBe(0);
    expect(wrapTileIndex(3, 3)).toBe(2);
    expect(wrapTileIndex(-1, 5)).toBe(4);
    expect(wrapTileIndex(5, 5)).toBe(0);
    expect(wrapTileIndex(-6, 5)).toBe(4);
  });

  it("computes progressive slot visibility across active, fade, and hidden zones", () => {
    const center = slotVisibility(0);
    expect(center).toEqual({
      opacity: 1,
      scale: 1,
      interactive: true,
      hidden: false,
    });

    const nearHorizonPos = slotVisibility(80);
    const nearHorizonNeg = slotVisibility(-80);
    for (const vis of [nearHorizonPos, nearHorizonNeg]) {
      expect(vis.interactive).toBe(true);
      expect(vis.hidden).toBe(false);
      expect(vis.opacity).toBeGreaterThanOrEqual(0.68);
      expect(vis.scale).toBeGreaterThanOrEqual(0.78);
    }

    const edgeVisible = slotVisibility(82);
    expect(edgeVisible.interactive).toBe(true);
    expect(edgeVisible.hidden).toBe(false);
    expect(edgeVisible.opacity).toBeCloseTo(0.68);

    const fading = slotVisibility(89);
    expect(fading.interactive).toBe(false);
    expect(fading.hidden).toBe(false);
    expect(fading.opacity).toBeCloseTo(0.34);
    expect(fading.scale).toBeCloseTo(0.7);

    for (const angle of [96, 100, 140]) {
      expect(slotVisibility(angle)).toEqual({
        opacity: 0,
        scale: 0.62,
        interactive: false,
        hidden: true,
      });
    }
  });

  it("applies 0.32x rubber-band damping for bounded dials and leaves circular drags unbounded", () => {
    expect(clampDragContinuousIndex(-1, 3)).toBeCloseTo(-0.32);
    expect(clampDragContinuousIndex(3, 3)).toBeCloseTo(2.32);
    expect(clampDragContinuousIndex(1.4, 3)).toBeCloseTo(1.4);

    expect(clampDragContinuousIndex(-1.5, 5)).toBeCloseTo(-1.5);
    expect(clampDragContinuousIndex(6.2, 5)).toBeCloseTo(6.2);
  });

  it("computes pointer angle around 12 o'clock and normalizes ±180° deltas", () => {
    expect(pointerAngleDeg(200, 100, 200, 200)).toBeCloseTo(0);
    expect(pointerAngleDeg(300, 200, 200, 200)).toBeCloseTo(90);
    expect(pointerAngleDeg(100, 200, 200, 200)).toBeCloseTo(-90);
    expect(pointerAngleDeg(200, 300, 200, 200)).toBeCloseTo(180);

    expect(normalizeAngleDeltaDeg(15)).toBe(15);
    expect(normalizeAngleDeltaDeg(-15)).toBe(-15);
    expect(normalizeAngleDeltaDeg(180)).toBe(180);
    expect(normalizeAngleDeltaDeg(-180)).toBe(-180);
    // Crossing +175° -> -175° gives raw delta -350°, normalized to +10°
    expect(normalizeAngleDeltaDeg(-350)).toBe(10);
    // Crossing -175° -> +175° gives raw delta +350°, normalized to -10°
    expect(normalizeAngleDeltaDeg(350)).toBe(-10);
    expect(normalizeAngleDeltaDeg(540)).toBe(180);
  });
});
