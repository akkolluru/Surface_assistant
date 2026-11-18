import { afterEach, describe, expect, it, vi } from "vitest";
import { DialAudioEngine, createDialAudio } from "../components/dialAudio";

interface MockAudioContextTracker {
  instances: MockAudioContext[];
}

class MockAudioParam {
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class MockAudioNode {
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  buffer: AudioBuffer | null = null;
  type: string = "";
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  gain = new MockAudioParam();
}

class MockAudioContext {
  state: AudioContextState = "suspended";
  sampleRate = 48000;
  currentTime = 1.25;
  destination = {} as AudioDestinationNode;
  channelData = new Float32Array(Math.floor(48000 * 0.03));

  createBuffer = vi.fn((_channels: number, length: number, _rate: number) => {
    this.channelData = new Float32Array(length);
    return {
      getChannelData: () => this.channelData,
    } as unknown as AudioBuffer;
  });

  createBufferSource = vi.fn(() => new MockAudioNode() as unknown as AudioBufferSourceNode);
  createBiquadFilter = vi.fn(() => new MockAudioNode() as unknown as BiquadFilterNode);
  createGain = vi.fn(() => new MockAudioNode() as unknown as GainNode);
  createOscillator = vi.fn(() => new MockAudioNode() as unknown as OscillatorNode);

  resume = vi.fn(async () => {
    this.state = "running";
  });

  close = vi.fn(async () => {
    this.state = "closed";
  });
}

function installMockAudioContext(
  key: "AudioContext" | "webkitAudioContext" = "AudioContext",
): MockAudioContextTracker {
  const tracker: MockAudioContextTracker = { instances: [] };
  class TrackedAudioContext extends MockAudioContext {
    constructor() {
      super();
      tracker.instances.push(this);
    }
  }
  vi.stubGlobal(key, TrackedAudioContext);
  return tracker;
}

describe("dialAudio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no-ops safely when AudioContext is unavailable in jsdom", () => {
    const audio = createDialAudio();
    expect(() => {
      audio.unlock();
      audio.play("tick");
      audio.play("detent");
      audio.dispose();
    }).not.toThrow();
  });

  it("unlocks suspended context, caches a single noise buffer, and rate-limits tick/detent cues", async () => {
    const tracker = installMockAudioContext("AudioContext");
    let nowMs = 100;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);

    const audio = new DialAudioEngine();

    // Suspended context must not synthesize stacked audio before unlock
    audio.play("tick");
    expect(tracker.instances).toHaveLength(1);
    const ctx = tracker.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx!.createBuffer).toHaveBeenCalledTimes(1);
    expect(ctx!.createBufferSource).not.toHaveBeenCalled();

    // Unlock resumes context cleanly
    audio.unlock();
    expect(ctx!.resume).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(ctx!.state).toBe("running");

    // Tick plays and is rate-limited inside 22ms
    audio.play("tick");
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(1);
    expect(ctx!.createBiquadFilter).toHaveBeenCalledTimes(1);
    expect(ctx!.createOscillator).toHaveBeenCalledTimes(1);
    expect(ctx!.createGain).toHaveBeenCalledTimes(2);

    nowMs = 115; // +15ms < 22ms cooldown
    audio.play("tick");
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(1);

    nowMs = 123; // +23ms >= 22ms cooldown
    audio.play("tick");
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(2);
    expect(ctx!.createBuffer).toHaveBeenCalledTimes(1); // Cached noise buffer reused

    // Detent plays and is rate-limited inside 40ms independently of tick
    nowMs = 130;
    audio.play("detent");
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(3);
    expect(ctx!.createOscillator).toHaveBeenCalledTimes(3);

    nowMs = 160; // +30ms < 40ms cooldown
    audio.play("detent");
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(3);

    nowMs = 171; // +41ms >= 40ms cooldown
    audio.play("detent");
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(4);

    // Dispose closes context and turns subsequent calls into safe no-ops
    audio.dispose();
    expect(ctx!.close).toHaveBeenCalledTimes(1);

    nowMs = 500;
    audio.play("tick");
    audio.unlock();
    expect(ctx!.createBufferSource).toHaveBeenCalledTimes(4);
  });

  it("falls back to webkitAudioContext and catches scheduling errors cleanly", () => {
    const tracker = installMockAudioContext("webkitAudioContext");
    const audio = createDialAudio();
    audio.unlock();

    const ctx = tracker.instances[0];
    expect(ctx).toBeDefined();
    ctx!.state = "running";
    ctx!.createOscillator.mockImplementation(() => {
      throw new Error("Node allocation blocked");
    });

    expect(() => audio.play("detent")).not.toThrow();
    audio.dispose();
  });
});
