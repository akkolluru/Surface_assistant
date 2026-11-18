/** Synthesized tactile sound cue for orbital dial rotation and magnetic slot locking. */
export type DialAudioCue = "tick" | "detent";

/** Minimal lifecycle interface for dial sound synthesis. */
export interface DialAudioHandle {
  unlock: () => void;
  play: (cue: DialAudioCue) => void;
  dispose: () => void;
}

type AudioContextConstructor = new () => AudioContext;

interface WindowWithWebkitAudio extends Window {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
}

interface NoiseLayerSpec {
  filterFreqHz: number;
  filterQ: number;
  peakGain: number;
  durationSec: number;
}

interface ToneLayerSpec {
  oscType: OscillatorType;
  startFreqHz: number;
  endFreqHz: number;
  peakGain: number;
  durationSec: number;
}

interface CueSynthesisSpec {
  noise: NoiseLayerSpec;
  tone: ToneLayerSpec;
}

const NOISE_BUFFER_DURATION_SEC = 0.03;
const MIN_TICK_INTERVAL_MS = 22;
const MIN_DETENT_INTERVAL_MS = 40;
const GAIN_FLOOR = 0.0001;

const CUE_SPECS: Record<DialAudioCue, CueSynthesisSpec> = {
  tick: {
    noise: {
      filterFreqHz: 3200,
      filterQ: 2.6,
      peakGain: 0.045,
      durationSec: 0.012,
    },
    tone: {
      oscType: "triangle",
      startFreqHz: 950,
      endFreqHz: 320,
      peakGain: 0.02,
      durationSec: 0.008,
    },
  },
  detent: {
    noise: {
      filterFreqHz: 1850,
      filterQ: 2.0,
      peakGain: 0.08,
      durationSec: 0.018,
    },
    tone: {
      oscType: "sine",
      startFreqHz: 210,
      endFreqHz: 68,
      peakGain: 0.1,
      durationSec: 0.028,
    },
  },
};

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const win = window as WindowWithWebkitAudio;
  return win.AudioContext ?? globalThis.AudioContext ?? win.webkitAudioContext ?? null;
}

function nowTimestampMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function scheduleNoiseLayer(
  ctx: AudioContext,
  noiseBuffer: AudioBuffer,
  startTime: number,
  spec: NoiseLayerSpec,
): void {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(spec.filterFreqHz, startTime);
  filter.Q.setValueAtTime(spec.filterQ, startTime);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(spec.peakGain, startTime);
  gain.gain.exponentialRampToValueAtTime(GAIN_FLOOR, startTime + spec.durationSec);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  source.start(startTime);
  source.stop(startTime + spec.durationSec);
}

function scheduleToneLayer(
  ctx: AudioContext,
  startTime: number,
  spec: ToneLayerSpec,
): void {
  const osc = ctx.createOscillator();
  osc.type = spec.oscType;
  osc.frequency.setValueAtTime(spec.startFreqHz, startTime);
  osc.frequency.exponentialRampToValueAtTime(spec.endFreqHz, startTime + spec.durationSec);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(spec.peakGain, startTime);
  gain.gain.exponentialRampToValueAtTime(GAIN_FLOOR, startTime + spec.durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + spec.durationSec);
}

/**
 * Synthesizes subtle rotary crown ratchet clicks (`"tick"`) and magnetic
 * slot-lock clicks (`"detent"`) using Web Audio with zero runtime buffer churn.
 */
export class DialAudioEngine implements DialAudioHandle {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastTickAtMs = -Infinity;
  private lastDetentAtMs = -Infinity;
  private disposed = false;

  private ensureContext(): AudioContext | null {
    if (this.disposed) {
      return null;
    }
    if (this.ctx) {
      return this.ctx;
    }

    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) {
      return null;
    }

    try {
      const ctx = new AudioCtx();
      const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_DURATION_SEC));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let idx = 0; idx < samples.length; idx += 1) {
        samples[idx] = Math.random() * 2 - 1;
      }

      this.ctx = ctx;
      this.noiseBuffer = buffer;
      return ctx;
    } catch {
      return null;
    }
  }

  /** Lazily initializes and resumes `AudioContext` inside a user gesture handler. */
  unlock = (): void => {
    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== "suspended") {
      return;
    }
    try {
      const maybePromise = ctx.resume();
      if (maybePromise && typeof maybePromise.catch === "function") {
        void maybePromise.catch(() => {});
      }
    } catch {
      // Ignore autoplay rejections before active user gesture completion.
    }
  };

  /** Plays a rate-limited mechanical ratchet tick or magnetic detent lock click. */
  play = (cue: DialAudioCue): void => {
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer || ctx.state !== "running") {
      return;
    }

    const nowMs = nowTimestampMs();
    const minInterval = cue === "detent" ? MIN_DETENT_INTERVAL_MS : MIN_TICK_INTERVAL_MS;
    const lastPlayedAt = cue === "detent" ? this.lastDetentAtMs : this.lastTickAtMs;
    if (nowMs - lastPlayedAt < minInterval) {
      return;
    }

    if (cue === "detent") {
      this.lastDetentAtMs = nowMs;
    } else {
      this.lastTickAtMs = nowMs;
    }

    const spec = CUE_SPECS[cue];
    try {
      const startTime = ctx.currentTime;
      scheduleNoiseLayer(ctx, this.noiseBuffer, startTime, spec.noise);
      scheduleToneLayer(ctx, startTime, spec.tone);
    } catch {
      // Ignore Web Audio scheduling errors so UI gestures remain unaffected.
    }
  };

  /** Closes the underlying `AudioContext` and prevents further sound synthesis. */
  dispose = (): void => {
    this.disposed = true;
    const ctx = this.ctx;
    this.ctx = null;
    this.noiseBuffer = null;
    if (!ctx || ctx.state === "closed") {
      return;
    }
    try {
      const maybePromise = ctx.close();
      if (maybePromise && typeof maybePromise.catch === "function") {
        void maybePromise.catch(() => {});
      }
    } catch {
      // Ignore close errors during teardown.
    }
  };
}

/** Factory creating a standalone {@link DialAudioEngine} instance. */
export function createDialAudio(): DialAudioHandle {
  return new DialAudioEngine();
}
