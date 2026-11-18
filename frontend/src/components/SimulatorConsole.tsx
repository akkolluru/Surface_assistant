import { useEffect, useState } from "react";
import {
  ExternalLink,
  MessageSquare,
  Moon,
  Send,
  Smartphone,
  Sun,
  Timer,
  Tv,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  connectDaemonSocket,
  daemonApi,
  DEFAULT_DAEMON_SNAPSHOT,
} from "../services/daemonSocket";
import type { DaemonStateSnapshot } from "../types/hub";

export function SimulatorConsole() {
  const [state, setState] = useState<DaemonStateSnapshot>(DEFAULT_DAEMON_SNAPSHOT);
  const [connected, setConnected] = useState(false);
  const [luxInput, setLuxInput] = useState(120);
  const [voiceQuery, setVoiceQuery] = useState("Tell me about Hyderabad");
  const [voiceAnswer, setVoiceAnswer] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [smsRecipient, setSmsRecipient] = useState("Mom");
  const [smsText, setSmsText] = useState("Reached home safely");
  const [statusLog, setStatusLog] = useState<string>("Ready for Mac simulation.");

  useEffect(() => {
    document.title = "Mac Hardware Simulator | Surface Hub";
    daemonApi
      .fetchState()
      .then((snap) => {
        setState(snap);
        if (snap.night_mode.lux !== null) {
          setLuxInput(Math.round(snap.night_mode.lux));
        }
      })
      .catch(() => setStatusLog("Daemon not reachable at 127.0.0.1:8000."));

    return connectDaemonSocket({
      onStatusChange: setConnected,
      onEvent: (event) => {
        if (event.type === "state") {
          setState(event.payload);
          if (event.payload.night_mode.lux !== null) {
            setLuxInput(Math.round(event.payload.night_mode.lux));
          }
        } else if (event.type === "toast") {
          setStatusLog(event.payload.message);
        }
      },
    });
  }, []);

  const applyLux = (nextLux: number) => {
    setLuxInput(nextLux);
    daemonApi
      .setSimLux(nextLux, true)
      .then((nm) =>
        setStatusLog(
          `Lux=${nextLux} -> Night Mode ${nm.enabled ? "ON" : "OFF"} (Backlight ${nm.backlight_percent}%)`
        )
      )
      .catch(() => setStatusLog("Failed to update simulated lux."));
  };

  const handleVoiceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voiceQuery.trim()) return;
    setVoiceBusy(true);
    try {
      const res = await daemonApi.queryKnowledge(voiceQuery);
      setVoiceAnswer(
        res.answer ? `[${res.source}] ${res.answer}` : "No Wikipedia/DuckDuckGo match found."
      );
    } catch {
      setVoiceAnswer("Failed reaching /api/knowledge/query.");
    } finally {
      setVoiceBusy(false);
    }
  };

  return (
    <div className="h-screen w-screen overflow-y-auto bg-zinc-950 text-white">
      <main className="mx-auto max-w-5xl space-y-6 p-6 md:p-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Surface Pro 5 Mac Simulator
            </h1>
            <p className="mt-1 text-sm text-white/60">
              Drive virtual hardware events on{" "}
              <span className="font-mono text-white/85">127.0.0.1:8000</span> while watching the
              Kiosk Hub update live.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                connected
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-rose-500/20 text-rose-300"
              }`}
            >
              {connected ? "WS Connected" : "WS Disconnected"}
            </span>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="touch-target flex items-center gap-1.5 rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
            >
              <span>Open Kiosk Hub</span>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </header>

        <div
          aria-live="polite"
          className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-sky-200"
        >
          {statusLog}
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Ambient Light Sensor */}
          <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-1 text-lg font-semibold">Ambient Light Sensor (IIO Lux)</h2>
            <p className="mb-4 text-xs text-white/60">
              Night Mode: <strong>{state.night_mode.enabled ? "ON" : "OFF"}</strong> · Backlight:{" "}
              <strong className="tabular-nums">{state.night_mode.backlight_percent}%</strong>
              {state.night_mode.paused_for_video ? " · Paused for Workspace 2 video" : ""}
            </p>
            <label htmlFor="sim-lux-slider" className="mb-2 block text-sm text-white/80">
              Room Illuminance: <span className="font-mono">{luxInput} lux</span>
            </label>
            <input
              id="sim-lux-slider"
              type="range"
              min={0}
              max={200}
              value={luxInput}
              onChange={(e) => applyLux(Number(e.target.value))}
              className="mb-4 h-2 w-full cursor-pointer accent-amber-400"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyLux(2)}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3.5 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/30"
              >
                <Moon className="h-4 w-4" aria-hidden="true" />
                Lights Off (2 lux)
              </button>
              <button
                type="button"
                onClick={() => applyLux(120)}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-sky-500/20 px-3.5 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-500/30"
              >
                <Sun className="h-4 w-4" aria-hidden="true" />
                Daylight (120 lux)
              </button>
            </div>
          </section>

          {/* Physical Volume Rocker */}
          <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-1 text-lg font-semibold">Physical Volume Rocker & Sinks</h2>
            <p className="mb-4 text-xs text-white/60">
              Media: {state.audio.media_percent}%{state.audio.media_muted ? " (Muted)" : ""} · TTS:{" "}
              {state.audio.tts_percent}% · Alarm: {state.audio.alarm_percent}%
            </p>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => daemonApi.pressRocker("down")}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20"
              >
                <Volume2 className="h-4 w-4" aria-hidden="true" />
                Rocker -5%
              </button>
              <button
                type="button"
                onClick={() => daemonApi.pressRocker("up")}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20"
              >
                <Volume2 className="h-4 w-4" aria-hidden="true" />
                Rocker +5%
              </button>
              <button
                type="button"
                onClick={() => daemonApi.pressRocker("mute")}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20"
              >
                <VolumeX className="h-4 w-4" aria-hidden="true" />
                Toggle Mute
              </button>
            </div>
          </section>

          {/* Sway Workspace 2 & Sleep Timer */}
          <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-1 text-lg font-semibold">Workspace 2 & Sleep Timer</h2>
            <p className="mb-4 text-xs text-white/60">
              Workspace: <strong>{state.media.active_workspace}</strong> · Active Tile:{" "}
              <strong>{state.media.active_tile_id ?? "None"}</strong>
              {state.media.sleep_timer_remaining_seconds !== null
                ? ` · Sleep in ${state.media.sleep_timer_remaining_seconds}s`
                : ""}
            </p>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => daemonApi.launchMedia("netflix")}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-red-500/20 px-3.5 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/30"
              >
                <Tv className="h-4 w-4" aria-hidden="true" />
                Launch Netflix (WS2)
              </button>
              <button
                type="button"
                onClick={() => daemonApi.returnHome()}
                className="touch-target rounded-xl bg-white/10 px-3.5 py-2 text-xs font-semibold hover:bg-white/20"
              >
                ⌂ Waybar Home Pill
              </button>
              <button
                type="button"
                onClick={() =>
                  daemonApi
                    .closeMedia()
                    .catch(() => setStatusLog("Failed to close running media."))
                }
                className="touch-target flex items-center gap-1.5 rounded-xl bg-rose-500/20 px-3.5 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Close Media
              </button>
              <button
                type="button"
                onClick={() => daemonApi.expireSleepTimer()}
                className="touch-target flex items-center gap-1.5 rounded-xl bg-violet-500/20 px-3.5 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-500/30"
              >
                <Timer className="h-4 w-4" aria-hidden="true" />
                Expire Sleep Timer Now
              </button>
            </div>
          </section>

          {/* KDE Connect Mock Telemetry */}
          <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-3 text-lg font-semibold">KDE Connect Device Telemetry</h2>
            <ul className="space-y-3">
              {state.devices.map((dev) => (
                <li
                  key={dev.id}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-black/35 px-3.5 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-sky-300" aria-hidden="true" />
                    <span className="text-sm font-medium">{dev.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        daemonApi.updateSimDevice({
                          id: dev.id,
                          battery_percent: Math.max(0, (dev.battery_percent ?? 50) - 10),
                        })
                      }
                      className="rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                    >
                      -10%
                    </button>
                    <span className="w-10 text-center text-xs font-semibold tabular-nums">
                      {dev.battery_percent ?? "--"}%
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        daemonApi.updateSimDevice({
                          id: dev.id,
                          charging: !dev.charging,
                        })
                      }
                      className={`rounded-lg px-2 py-1 text-xs ${
                        dev.charging
                          ? "bg-emerald-500/25 text-emerald-200"
                          : "bg-white/10 text-white/70"
                      }`}
                    >
                      {dev.charging ? "Charging" : "Battery"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Knowledge & Messaging Tester */}
          <section className="rounded-3xl border border-white/10 bg-white/5 p-5 md:col-span-2">
            <h2 className="mb-3 text-lg font-semibold">
              Voice Knowledge & KDE Messaging Tester
            </h2>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <form onSubmit={handleVoiceSubmit} className="space-y-3">
                <label htmlFor="sim-voice-query" className="block text-sm text-white/80">
                  Test Wiki / DuckDuckGo / Open-Meteo Fallback
                </label>
                <div className="flex gap-2">
                  <input
                    id="sim-voice-query"
                    type="text"
                    value={voiceQuery}
                    onChange={(e) => setVoiceQuery(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-black/50 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="submit"
                    disabled={voiceBusy}
                    className="touch-target rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
                  >
                    {voiceBusy ? "..." : "Ask"}
                  </button>
                </div>
                {voiceAnswer && (
                  <p className="rounded-xl bg-black/40 p-3 text-xs leading-relaxed text-white/85">
                    {voiceAnswer}
                  </p>
                )}
              </form>

              <div className="space-y-3">
                <label htmlFor="sim-sms-recipient" className="block text-sm text-white/80">
                  Simulate KDE Connect SMS / WhatsApp Reply
                </label>
                <div className="flex gap-2">
                  <input
                    id="sim-sms-recipient"
                    type="text"
                    value={smsRecipient}
                    onChange={(e) => setSmsRecipient(e.target.value)}
                    aria-label="Recipient"
                    className="w-32 rounded-xl border border-white/15 bg-black/50 px-3 py-2 text-sm text-white"
                  />
                  <input
                    id="sim-sms-text"
                    type="text"
                    value={smsText}
                    onChange={(e) => setSmsText(e.target.value)}
                    aria-label="Message body"
                    className="w-full rounded-xl border border-white/15 bg-black/50 px-3 py-2 text-sm text-white"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => daemonApi.sendMockSms(smsRecipient, smsText)}
                    className="touch-target flex items-center gap-1.5 rounded-xl bg-white/10 px-3.5 py-2 text-xs font-semibold hover:bg-white/20"
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    Send Mock SMS
                  </button>
                  <button
                    type="button"
                    onClick={() => daemonApi.replyMockWhatsApp(smsRecipient, smsText)}
                    className="touch-target flex items-center gap-1.5 rounded-xl bg-emerald-500/20 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
                  >
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                    Mock WhatsApp Reply
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
