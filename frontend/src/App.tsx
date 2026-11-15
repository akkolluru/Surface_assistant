import { useCallback, useEffect, useRef, useState } from "react";
import { AmbientHubPane } from "./components/AmbientHubPane";
import { MediaLauncher } from "./components/MediaLauncher";
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
  const [daemonState, setDaemonState] = useState<DaemonStateSnapshot>(DEFAULT_DAEMON_SNAPSHOT);
  const [haEntities, setHaEntities] = useState<Record<string, SmartEntityState>>(
    PLACEHOLDER_HA_ENTITIES
  );
  const [haConnected, setHaConnected] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<0 | 1 | 2>(1);

  const scrollerRef = useRef<HTMLElement>(null);
  const haClientRef = useRef<HaClient | null>(null);
  const osdTimerRef = useRef<number | null>(null);

  const navigatePane = useCallback((index: 0 | 1 | 2, behavior: ScrollBehavior = "smooth") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const target = scroller.children.item(index) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior, inline: "start", block: "nearest" });
    }
    setActivePane(index);
  }, []);

  // Center on Pane 1 (Ambient Hub) on initial mount
  useEffect(() => {
    navigatePane(1, "auto");
  }, [navigatePane]);

  useEffect(() => {
    document.title = PANE_TITLES[activePane];
  }, [activePane]);

  // Sync activePane using scrollsnapchange (or IntersectionObserver fallback)
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const handleSnapChange = (event: Event) => {
      const snapTarget = (event as Event & { snapTargetInline?: Element | null }).snapTargetInline;
      if (!snapTarget) return;
      const idx = Array.from(scroller.children).indexOf(snapTarget);
      if (idx === 0 || idx === 1 || idx === 2) {
        setActivePane(idx);
      }
    };

    if ("onscrollsnapchange" in HTMLElement.prototype) {
      scroller.addEventListener("scrollsnapchange", handleSnapChange);
      return () => scroller.removeEventListener("scrollsnapchange", handleSnapChange);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const idx = Array.from(scroller.children).indexOf(entry.target);
            if (idx === 0 || idx === 1 || idx === 2) {
              setActivePane(idx);
            }
          }
        }
      },
      { root: scroller, threshold: 0.6 }
    );
    Array.from(scroller.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, []);

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

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <main
        ref={scrollerRef}
        tabIndex={0}
        aria-label="Bedside Hub Panes"
        className="pane-scroller"
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
