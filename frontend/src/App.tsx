import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent } from "react";
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
  const osdAutoCloseRef = useRef(false);
  const volumeOpenRef = useRef(false);
  const suppressTimerRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLElement>(null);
  const pane0Ref = useRef<HTMLDivElement>(null);
  const pane1Ref = useRef<HTMLDivElement>(null);
  const pane2Ref = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
  } | null>(null);

  useEffect(() => {
    volumeOpenRef.current = volumeOpen;
  }, [volumeOpen]);

  const scheduleOsdAutoClose = useCallback(() => {
    if (osdTimerRef.current !== null) {
      window.clearTimeout(osdTimerRef.current);
    }
    osdTimerRef.current = window.setTimeout(() => {
      osdAutoCloseRef.current = false;
      osdTimerRef.current = null;
      setVolumeOpen(false);
    }, 5000);
  }, []);

  const navigatePane = useCallback((index: 0 | 1 | 2) => {
    setDragOffsetPx(0);
    setIsDragging(false);
    setActivePane(index);
  }, []);

  useEffect(() => {
    document.title = PANE_TITLES[activePane];
    if (pane0Ref.current) pane0Ref.current.inert = activePane !== 0;
    if (pane1Ref.current) pane1Ref.current.inert = activePane !== 1;
    if (pane2Ref.current) pane2Ref.current.inert = activePane !== 2;
  }, [activePane]);

  // Connect Daemon REST + WebSocket
  useEffect(() => {
    let active = true;
    let hasLiveState = false;
    daemonApi
      .fetchState()
      .then((snap) => {
        if (active && !hasLiveState) setDaemonState(snap);
      })
      .catch(() => {
        // Keep DEFAULT_DAEMON_SNAPSHOT when running frontend standalone
      });

    const disconnect = connectDaemonSocket({
      onEvent: (event) => {
        if (event.type === "state") {
          hasLiveState = true;
          setDaemonState(event.payload);
        } else if (event.type === "osd") {
          setDaemonState((prev) => ({ ...prev, audio: event.payload.audio }));
          if (!volumeOpenRef.current || osdAutoCloseRef.current) {
            osdAutoCloseRef.current = true;
            setVolumeOpen(true);
            scheduleOsdAutoClose();
          }
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
  }, [scheduleOsdAutoClose]);

  // Connect Home Assistant WebSocket (or fall back cleanly to template mode)
  useEffect(() => {
    let disposed = false;
    const client = new HaClient((entities, live) => {
      if (!disposed) {
        setHaEntities(entities);
        setHaConnected(live);
      }
    });
    haClientRef.current = client;
    let cleanup: (() => void) | undefined;
    client.connect().then((fn) => {
      if (disposed) {
        fn();
      } else {
        cleanup = fn;
      }
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
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
    if (osdAutoCloseRef.current) {
      scheduleOsdAutoClose();
    }
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

  const clearSuppressTimer = useCallback(() => {
    if (suppressTimerRef.current !== null) {
      window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSuppressTimer, [clearSuppressTimer]);

  const finalizeDrag = useCallback(
    (pointerId: number | null, finalX?: number, canceled = false, finalY?: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (pointerId !== null && drag.pointerId !== pointerId) return;

      const dx = (finalX ?? drag.lastX) - drag.startX;
      const dy = (finalY ?? drag.lastY) - drag.startY;
      const wasActive = drag.active;
      dragRef.current = null;

      try {
        if (trackRef.current?.hasPointerCapture?.(drag.pointerId)) {
          trackRef.current.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Ignore capture release errors in synthetic environments
      }

      // Handle fast flicks where pointerup arrives before intermediate pointermove crossed 28px
      const isFastFlick =
        !wasActive &&
        !canceled &&
        Math.abs(dx) > 60 &&
        Math.abs(dx) > Math.abs(dy) * 1.4;

      if (!wasActive && !isFastFlick) {
        return;
      }

      if (isFastFlick) {
        suppressClickRef.current = true;
      }

      clearSuppressTimer();
      suppressTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressTimerRef.current = null;
      }, 150);

      if (!canceled && dx < -60 && activePane < 2) {
        navigatePane((activePane + 1) as 0 | 1 | 2);
        return;
      }
      if (!canceled && dx > 60 && activePane > 0) {
        navigatePane((activePane - 1) as 0 | 1 | 2);
        return;
      }
      navigatePane(activePane);
    },
    [activePane, clearSuppressTimer, navigatePane]
  );

  useEffect(() => {
    const onWindowPointerUp = (e: globalThis.PointerEvent) =>
      finalizeDrag(e.pointerId, e.clientX, false, e.clientY);
    const onWindowPointerCancel = (e: globalThis.PointerEvent) =>
      finalizeDrag(e.pointerId, e.clientX, true, e.clientY);
    const onWindowBlur = () => finalizeDrag(null, undefined, true);

    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [finalizeDrag]);

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.isPrimary === false) return;
    if (dragRef.current !== null) return;

    clearSuppressTimer();
    suppressClickRef.current = false;

    const target = event.target as HTMLElement | null;
    if (target?.closest("input, select, textarea, [role='slider'], [data-dial-ring]")) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    if (!drag.active) {
      if (Math.abs(dx) < 28 || Math.abs(dx) <= Math.abs(dy) * 1.4) {
        return;
      }
      drag.active = true;
      suppressClickRef.current = true;
      setIsDragging(true);
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Ignore pointer capture errors when pointerId is synthetic
      }
    }

    const atLeftEdge = activePane === 0 && dx > 0;
    const atRightEdge = activePane === 2 && dx < 0;
    const damped = atLeftEdge || atRightEdge ? dx * 0.35 : dx;
    setDragOffsetPx(damped);
  };

  const handlePointerUp = (event: PointerEvent<HTMLElement>) => {
    finalizeDrag(event.pointerId, event.clientX, false, event.clientY);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLElement>) => {
    finalizeDrag(event.pointerId, undefined, true);
  };

  const handleLostPointerCapture = (event: PointerEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    finalizeDrag(event.pointerId);
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      clearSuppressTimer();
      event.preventDefault();
      event.stopPropagation();
    }
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
        ref={trackRef}
        tabIndex={0}
        aria-label="Bedside Hub Panes"
        className="pane-track"
        style={trackStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onClickCapture={handleClickCapture}
        onKeyDown={handleKeyDown}
      >
        <div
          ref={pane0Ref}
          className="h-screen w-screen shrink-0"
          aria-hidden={activePane !== 0}
        >
          <SmartHomePane
            entities={haEntities}
            haConnected={haConnected}
            onCallService={(domain, service, data) =>
              haClientRef.current?.callService(domain, service, data)
            }
            onNavigateHub={() => navigatePane(1)}
          />
        </div>

        <div
          ref={pane1Ref}
          className="h-screen w-screen shrink-0"
          aria-hidden={activePane !== 1}
        >
          <AmbientHubPane
            state={daemonState}
            onNextWallpaper={handleNextWallpaper}
            onSetSleepTimer={handleSleepTimer}
            onToggleNightMode={handleToggleNightMode}
            onOpenVolume={() => {
              osdAutoCloseRef.current = false;
              if (osdTimerRef.current !== null) {
                window.clearTimeout(osdTimerRef.current);
                osdTimerRef.current = null;
              }
              setVolumeOpen(true);
            }}
            onNavigatePane={navigatePane}
          />
        </div>

        <div
          ref={pane2Ref}
          className="h-screen w-screen shrink-0"
          aria-hidden={activePane !== 2}
        >
          <MediaLauncher
            tiles={daemonState.tiles}
            activeTileId={daemonState.media.active_tile_id}
            onLaunchTile={handleLaunchMedia}
            onNavigateHub={() => navigatePane(1)}
          />
        </div>
      </main>

      {/* Bottom Pane Indicator Dots (hidden in Night Mode) */}
      {!daemonState.night_mode.enabled && (
        <nav
          aria-label="Pane navigation"
          className="pointer-events-none fixed inset-x-0 bottom-1 z-20 flex justify-center gap-1"
        >
          {([0, 1, 2] as const).map((idx) => (
            <button
              key={idx}
              type="button"
              aria-label={`Go to ${PANE_TITLES[idx]}`}
              aria-current={activePane === idx ? "page" : undefined}
              onClick={() => navigatePane(idx)}
              className="touch-target pointer-events-auto flex items-center justify-center rounded-full p-3"
            >
              <span
                aria-hidden="true"
                className={`h-2 rounded-full transition-all ${
                  activePane === idx ? "w-6 bg-white/85" : "w-2 bg-white/30 hover:bg-white/55"
                }`}
              />
            </button>
          ))}
        </nav>
      )}

      <VolumeOSD
        open={volumeOpen}
        audio={daemonState.audio}
        onClose={() => {
          osdAutoCloseRef.current = false;
          if (osdTimerRef.current !== null) {
            window.clearTimeout(osdTimerRef.current);
            osdTimerRef.current = null;
          }
          setVolumeOpen(false);
        }}
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
