import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { AmbientHubPane } from "./components/AmbientHubPane";
import { MediaLauncher } from "./components/MediaLauncher";
import { SimulatorConsole } from "./components/SimulatorConsole";
import { SmartHomePane } from "./components/SmartHomePane";
import { VolumeOSD } from "./components/VolumeOSD";
import {
  connectDaemonSocket,
  daemonApi,
  DEFAULT_DAEMON_SNAPSHOT,
} from "./services/daemonSocket";
import { HaClient, PLACEHOLDER_HA_ENTITIES } from "./services/haSocket";
import type { AudioChannel, DaemonStateSnapshot, SmartEntityState } from "./types/hub";

const PANE_TITLES = [
  "Room Controls | Surface Hub",
  "Surface Bedside Hub",
  "Bedside Theater | Surface Hub",
] as const;

export function App() {
  if (typeof window !== "undefined" && window.location.pathname === "/sim") {
    return <SimulatorConsole />;
  }

  return <KioskHub />;
}

function KioskHub() {
  const [daemonState, setDaemonState] = useState<DaemonStateSnapshot>(DEFAULT_DAEMON_SNAPSHOT);
  const [haEntities, setHaEntities] = useState<Record<string, SmartEntityState>>(
    PLACEHOLDER_HA_ENTITIES
  );
  const [haConnected, setHaConnected] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<0 | 1 | 2>(1);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const haClientRef = useRef<HaClient | null>(null);
  const osdTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

  const navigatePane = useCallback((index: 0 | 1 | 2) => {
    setDragOffsetPx(0);
    setIsDragging(false);
    setActivePane(index);
  }, []);

  useEffect(() => {
    document.title = PANE_TITLES[activePane];
  }, [activePane]);

  // Connect Daemon REST + WebSocket
  useEffect(() => {
    let active = true;
    daemonApi
      .fetchState()
      .then((snap) => {
        if (active) setDaemonState(snap);
      })
      .catch(() => {
        // Keep DEFAULT_DAEMON_SNAPSHOT when running frontend standalone
      });

    const disconnect = connectDaemonSocket({
      onEvent: (event) => {
        if (event.type === "state") {
          setDaemonState(event.payload);
        } else if (event.type === "osd") {
          setDaemonState((prev) => ({ ...prev, audio: event.payload.audio }));
          setVolumeOpen(true);
          if (osdTimerRef.current !== null) window.clearTimeout(osdTimerRef.current);
          osdTimerRef.current = window.setTimeout(() => setVolumeOpen(false), 5000);
        } else if (event.type === "toast") {
          setToastMessage(event.payload.message);
        }
      },
    });

    return () => {
      active = false;
      if (osdTimerRef.current !== null) window.clearTimeout(osdTimerRef.current);
      disconnect();
    };
  }, []);

  // Connect Home Assistant WebSocket (or fall back cleanly to template mode)
  useEffect(() => {
    const client = new HaClient((entities, live) => {
      setHaEntities(entities);
      setHaConnected(live);
    });
    haClientRef.current = client;
    let cleanup: (() => void) | undefined;
    client.connect().then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const t = window.setTimeout(() => setToastMessage(null), 4000);
    return () => window.clearTimeout(t);
  }, [toastMessage]);

  const handleAudioChange = (
    channel: AudioChannel,
    payload: { percent?: number; muted?: boolean }
  ) => {
    if (osdTimerRef.current !== null) window.clearTimeout(osdTimerRef.current);
    setDaemonState((prev) => ({
      ...prev,
      audio: {
        ...prev.audio,
        ...(payload.percent !== undefined ? { [`${channel}_percent`]: payload.percent } : {}),
        ...(payload.muted !== undefined ? { [`${channel}_muted`]: payload.muted } : {}),
      },
    }));
    daemonApi.setAudioLevel(channel, payload).catch(() => {});
  };

  const handleLaunchMedia = (tileId: string) => {
    daemonApi
      .launchMedia(tileId)
      .then((media) => setDaemonState((prev) => ({ ...prev, media })))
      .catch(() => setToastMessage("Could not reach hardware daemon."));
  };

  const handleNextWallpaper = () => {
    daemonApi
      .nextWallpaper()
      .then((wallpapers) => setDaemonState((prev) => ({ ...prev, wallpapers })))
      .catch(() => {});
  };

  const handleSleepTimer = (minutes: number) => {
    daemonApi
      .setSleepTimer(minutes)
      .then((media) => setDaemonState((prev) => ({ ...prev, media })))
      .catch(() => {});
  };

  const handleToggleNightMode = (enabled: boolean | null) => {
    setDaemonState((prev) => ({
      ...prev,
      night_mode: { ...prev.night_mode, enabled: Boolean(enabled) },
    }));
    daemonApi
      .setNightMode(enabled)
      .then((night_mode) => setDaemonState((prev) => ({ ...prev, night_mode })))
      .catch(() => {});
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, select, textarea, a, [role='slider']")) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(dx) < 14 || Math.abs(dx) <= Math.abs(dy) * 1.2) {
        return;
      }
      drag.active = true;
      setIsDragging(true);
    }

    const atLeftEdge = activePane === 0 && dx > 0;
    const atRightEdge = activePane === 2 && dx < 0;
    const damped = atLeftEdge || atRightEdge ? dx * 0.35 : dx;
    setDragOffsetPx(damped);
  };

  const finishDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const wasActive = drag.active;
    dragRef.current = null;
    if (!wasActive) return;

    if (dx < -60 && activePane < 2) {
      navigatePane((activePane + 1) as 0 | 1 | 2);
      return;
    }
    if (dx > 60 && activePane > 0) {
      navigatePane((activePane - 1) as 0 | 1 | 2);
      return;
    }
    navigatePane(activePane);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
      return;
    }
    if (event.key === "ArrowLeft" && activePane > 0) {
      navigatePane((activePane - 1) as 0 | 1 | 2);
    } else if (event.key === "ArrowRight" && activePane < 2) {
      navigatePane((activePane + 1) as 0 | 1 | 2);
    }
  };

  const trackStyle: CSSProperties = {
    transform: `translate3d(calc(-${activePane * 100}vw + ${dragOffsetPx}px), 0, 0)`,
    transition: isDragging ? "none" : "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <main
        tabIndex={0}
        aria-label="Bedside Hub Panes"
        className="pane-track"
        style={trackStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={handleKeyDown}
      >
        <SmartHomePane
          entities={haEntities}
          haConnected={haConnected}
          onCallService={(domain, service, data) =>
            haClientRef.current?.callService(domain, service, data)
          }
          onNavigateHub={() => navigatePane(1)}
        />

        <AmbientHubPane
          state={daemonState}
          onNextWallpaper={handleNextWallpaper}
          onSetSleepTimer={handleSleepTimer}
          onToggleNightMode={handleToggleNightMode}
          onOpenVolume={() => setVolumeOpen(true)}
          onNavigatePane={navigatePane}
        />

        <MediaLauncher
          tiles={daemonState.tiles}
          activeTileId={daemonState.media.active_tile_id}
          onLaunchTile={handleLaunchMedia}
          onNavigateHub={() => navigatePane(1)}
        />
      </main>

      {/* Bottom Pane Indicator Dots (hidden in Night Mode) */}
      {!daemonState.night_mode.enabled && (
        <nav
          aria-label="Pane navigation"
          className="pointer-events-none fixed inset-x-0 bottom-3 z-20 flex justify-center gap-2"
        >
          {([0, 1, 2] as const).map((idx) => (
            <button
              key={idx}
              type="button"
              aria-label={`Go to ${PANE_TITLES[idx]}`}
              aria-current={activePane === idx ? "page" : undefined}
              onClick={() => navigatePane(idx)}
              className={`pointer-events-auto h-2 rounded-full transition-all ${
                activePane === idx ? "w-6 bg-white/85" : "w-2 bg-white/30 hover:bg-white/55"
              }`}
            />
          ))}
        </nav>
      )}

      <VolumeOSD
        open={volumeOpen}
        audio={daemonState.audio}
        onClose={() => setVolumeOpen(false)}
        onChangeLevel={handleAudioChange}
      />

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-5 z-50 flex justify-center">
        {toastMessage && (
          <div className="glass-panel rounded-full px-5 py-2 text-sm font-medium text-white shadow-xl">
            {toastMessage}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
