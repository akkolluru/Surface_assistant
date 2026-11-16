import { useEffect, useRef, useState } from "react";
import { Laptop, Smartphone, Tablet, Zap } from "lucide-react";
import type { ConnectedDevice, DeviceKind } from "../types/hub";

interface DevicePillProps {
  devices: ConnectedDevice[];
}

function DeviceIcon({ kind, className }: { kind: DeviceKind; className?: string }) {
  if (kind === "laptop") return <Laptop className={className} aria-hidden="true" />;
  if (kind === "tablet") return <Tablet className={className} aria-hidden="true" />;
  return <Smartphone className={className} aria-hidden="true" />;
}

export function DevicePill({ devices }: DevicePillProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;

    const collapseTimer = window.setTimeout(() => setExpanded(false), 10000);
    const handleOutside = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    };

    window.addEventListener("pointerdown", handleOutside);
    return () => {
      window.clearTimeout(collapseTimer);
      window.removeEventListener("pointerdown", handleOutside);
    };
  }, [expanded]);

  const reachableCount = devices.filter((d) => d.reachable).length;

  return (
    <div ref={containerRef} className="relative flex flex-col items-end">
      {expanded && (
        <div
          id="device-pill-panel"
          role="region"
          aria-label="Connected device batteries"
          className="glass-panel mb-3 w-72 rounded-2xl p-3.5 shadow-2xl transition-all duration-200"
        >
          <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-wide text-white/60 uppercase">
            <span>KDE Connect</span>
            <span>
              {reachableCount}/{devices.length} online
            </span>
          </div>
          {devices.length === 0 ? (
            <p className="py-2 text-sm text-white/60">No paired devices found.</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2"
                >
                  <div className="flex items-center gap-2.5">
                    <DeviceIcon kind={device.device_type} className="h-4 w-4 text-sky-300" />
                    <div>
                      <p className="text-sm font-medium text-white">{device.name}</p>
                      <p className="text-xs text-white/50">
                        {device.reachable ? "Connected" : "Offline"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-sm font-semibold tabular-nums">
                    {device.charging && (
                      <Zap className="h-3.5 w-3.5 text-emerald-400" aria-label="Charging" />
                    )}
                    <span className={device.reachable ? "text-white" : "text-white/40"}>
                      {device.battery_percent !== null ? `${device.battery_percent}%` : "--"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="device-pill-panel"
        aria-label={`Connected devices (${reachableCount} online)`}
        onClick={() => setExpanded((prev) => !prev)}
        className="glass-panel touch-target flex items-center gap-2.5 rounded-full px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/15 active:bg-white/20 active:brightness-110"
      >
        {devices.length === 0 ? (
          <Smartphone className="h-4 w-4 text-white/60" aria-hidden="true" />
        ) : (
          devices.map((device) => (
            <span key={device.id} className="relative flex items-center">
              <DeviceIcon
                kind={device.device_type}
                className={`h-4 w-4 ${device.reachable ? "text-white/90" : "text-white/35"}`}
              />
              {device.charging && (
                <span
                  aria-hidden="true"
                  className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400"
                />
              )}
            </span>
          ))
        )}
      </button>
    </div>
  );
}
