import { ChevronRight, Lamp, Lightbulb, Minus, Plug, Plus, Snowflake, Sparkles } from "lucide-react";
import type { SmartEntityState } from "../types/hub";

interface SmartHomePaneProps {
  entities: Record<string, SmartEntityState>;
  haConnected: boolean;
  onCallService: (domain: string, service: string, data: Record<string, unknown>) => void;
  onNavigateHub: () => void;
}

export function SmartHomePane({
  entities,
  haConnected,
  onCallService,
  onNavigateHub,
}: SmartHomePaneProps) {
  const mainLightOn = entities["input_boolean.bedroom_main_light"]?.state === "on";
  const lampOn = entities["input_boolean.bedside_lamp"]?.state === "on";
  const brightness = Number(entities["input_number.bedroom_light_brightness"]?.state ?? 60);

  const acOn = entities["input_boolean.bedroom_ac_power"]?.state === "on";
  const acTemp = Number(entities["input_number.bedroom_ac_temp"]?.state ?? 24);
  const acMode = entities["input_select.bedroom_ac_mode"]?.state ?? "Cool";
  const acModes = ["Cool", "Dry", "Fan", "Eco"];

  const deskPlugOn = entities["input_boolean.desk_plug"]?.state === "on";
  const fanPlugOn = entities["input_boolean.fan_plug"]?.state === "on";

  const toggleBool = (entityId: string) =>
    onCallService("input_boolean", "toggle", { entity_id: entityId });

  return (
    <section
      aria-label="Smart Home Controls"
      className="pane-item relative flex h-full w-full flex-col justify-between bg-gradient-to-br from-slate-950 via-zinc-950 to-slate-900 px-8 pt-8 pb-11 md:px-10"
    >
      {/* Upper ambient status display (non-interactive; all touch controls sit in the lower deck) */}
      <header className="pointer-events-none flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-white">Room Controls</h2>
          <p className="mt-1 text-sm text-white/55">
            {haConnected ? "Home Assistant Live" : "Home Assistant Template Mode (Ready for Hardware)"}
          </p>
        </div>
        <span className="text-xs text-white/45">
          Swipe left or tap Hub to return to Ambient Hub
        </span>
      </header>

      {/* Bottom-aligned interactive control deck (y >= 650px on 1563x1042) */}
      <div className="mt-auto flex flex-col gap-3.5">
        {/* Top bar of lower deck: One-tap Scenes + Hub navigation button */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="glass-panel flex flex-wrap items-center gap-2 rounded-full px-3 py-1.5">
            <span className="flex items-center gap-1.5 px-2 text-xs font-semibold text-violet-300">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>Scenes</span>
            </span>
            {[
              { id: "scene.evening_relax", label: "Relax" },
              { id: "scene.movie_night", label: "Movie" },
              { id: "scene.goodnight", label: "Goodnight" },
            ].map((scene) => (
              <button
                key={scene.id}
                type="button"
                onClick={() => onCallService("scene", "turn_on", { entity_id: scene.id })}
                className="touch-target rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/20 active:bg-white/25"
              >
                {scene.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onNavigateHub}
            className="glass-panel touch-target flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium text-white/90 hover:bg-white/15"
          >
            <span>Hub</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* 3-Column Lower Control Grid */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Bedroom Lighting */}
          <article className="glass-panel flex flex-col justify-between rounded-3xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="rounded-2xl bg-amber-400/15 p-2 text-amber-300">
                  <Lightbulb className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Bedroom Lighting</h3>
                  <p className="text-xs text-white/50">Ceiling & bedside fixtures</p>
                </div>
              </div>
              <button
                type="button"
                aria-pressed={mainLightOn}
                onClick={() => toggleBool("input_boolean.bedroom_main_light")}
                className={`touch-target rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                  mainLightOn ? "bg-amber-400 text-slate-950" : "bg-white/10 text-white/75"
                }`}
              >
                {mainLightOn ? "On" : "Off"}
              </button>
            </div>

            <div className="space-y-2">
              <label className="block">
                <div className="mb-0.5 flex justify-between text-xs text-white/65">
                  <span>Ceiling Brightness</span>
                  <span className="tabular-nums">{brightness}%</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={100}
                  step={5}
                  value={brightness}
                  onChange={(e) =>
                    onCallService("input_number", "set_value", {
                      entity_id: "input_number.bedroom_light_brightness",
                      value: Number(e.target.value),
                    })
                  }
                  className="min-h-11 w-full cursor-pointer touch-none py-2 accent-amber-400"
                />
              </label>

              <button
                type="button"
                aria-pressed={lampOn}
                onClick={() => toggleBool("input_boolean.bedside_lamp")}
                className={`touch-target flex w-full items-center justify-between rounded-2xl px-3.5 py-2 text-xs font-medium transition ${
                  lampOn ? "bg-amber-400/20 text-amber-200" : "bg-white/5 text-white/75"
                }`}
              >
                <span className="flex items-center gap-2">
                  <Lamp className="h-4 w-4" aria-hidden="true" />
                  Bedside Warm Lamp
                </span>
                <span>{lampOn ? "On" : "Off"}</span>
              </button>
            </div>
          </article>

          {/* Climate / AC */}
          <article className="glass-panel flex flex-col justify-between rounded-3xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="rounded-2xl bg-sky-400/15 p-2 text-sky-300">
                  <Snowflake className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Climate / AC</h3>
                  <p className="text-xs text-white/50">Mode: {acMode}</p>
                </div>
              </div>
              <button
                type="button"
                aria-pressed={acOn}
                onClick={() => toggleBool("input_boolean.bedroom_ac_power")}
                className={`touch-target rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                  acOn ? "bg-sky-400 text-slate-950" : "bg-white/10 text-white/75"
                }`}
              >
                {acOn ? "On" : "Off"}
              </button>
            </div>

            <div className="mb-2 flex items-center justify-between rounded-2xl bg-white/5 px-3.5 py-1.5">
              <button
                type="button"
                aria-label="Decrease AC target temperature"
                onClick={() =>
                  onCallService("input_number", "set_value", {
                    entity_id: "input_number.bedroom_ac_temp",
                    value: Math.max(18, acTemp - 1),
                  })
                }
                className="touch-target flex items-center justify-center rounded-full bg-white/10 p-2 hover:bg-white/20"
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </button>
              <span className="text-xl font-semibold tabular-nums text-white">{acTemp}°C</span>
              <button
                type="button"
                aria-label="Increase AC target temperature"
                onClick={() =>
                  onCallService("input_number", "set_value", {
                    entity_id: "input_number.bedroom_ac_temp",
                    value: Math.min(30, acTemp + 1),
                  })
                }
                className="touch-target flex items-center justify-center rounded-full bg-white/10 p-2 hover:bg-white/20"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {acModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={acMode === mode}
                  onClick={() =>
                    onCallService("input_select", "select_option", {
                      entity_id: "input_select.bedroom_ac_mode",
                      option: mode,
                    })
                  }
                  className={`touch-target rounded-xl py-1.5 text-xs font-medium transition ${
                    acMode === mode ? "bg-sky-400/25 text-sky-200" : "bg-white/5 text-white/65"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </article>

          {/* Smart Plugs */}
          <article className="glass-panel flex flex-col justify-between rounded-3xl p-4">
            <div className="mb-2 flex items-center gap-2.5">
              <div className="rounded-2xl bg-emerald-400/15 p-2 text-emerald-300">
                <Plug className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Smart Plugs</h3>
                <p className="text-xs text-white/50">Bedroom outlets</p>
              </div>
            </div>
            <div className="my-auto grid grid-cols-2 gap-3">
              <button
                type="button"
                aria-pressed={deskPlugOn}
                onClick={() => toggleBool("input_boolean.desk_plug")}
                className={`touch-target flex min-h-24 flex-col justify-between rounded-2xl p-3.5 text-left transition ${
                  deskPlugOn ? "bg-emerald-400/20 text-emerald-100" : "bg-white/5 text-white/75"
                }`}
              >
                <p className="text-sm font-medium">Desk Plug</p>
                <p className="text-xs opacity-70">{deskPlugOn ? "On" : "Off"}</p>
              </button>
              <button
                type="button"
                aria-pressed={fanPlugOn}
                onClick={() => toggleBool("input_boolean.fan_plug")}
                className={`touch-target flex min-h-24 flex-col justify-between rounded-2xl p-3.5 text-left transition ${
                  fanPlugOn ? "bg-emerald-400/20 text-emerald-100" : "bg-white/5 text-white/75"
                }`}
              >
                <p className="text-sm font-medium">Standing Fan</p>
                <p className="text-xs opacity-70">{fanPlugOn ? "On" : "Off"}</p>
              </button>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
