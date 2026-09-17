import { useEffect } from "react";
import { formatMmSs } from "@/lib/utils";
import { resumeAudio } from "@/lib/pomodoro/audio";
import { installPressGuards } from "@/lib/pomodoro/press";
import {
  PHASE_LABEL,
  selectCharState,
  usePomodoro,
} from "@/lib/pomodoro/store";
import { STORAGE_KEY } from "@/lib/pomodoro/types";
import { useRemainingMs } from "@/lib/pomodoro/useRemaining";
import { CharacterStage } from "./CharacterStage";
import { Petals } from "./Petals";
import { SettingsSheet } from "./SettingsSheet";
import { TimerPanel } from "./TimerPanel";

const TITLE_IDLE = "樱时 · Sakura Focus";

function DocumentTitle() {
  const remainingMs = useRemainingMs();
  const status = usePomodoro((s) => s.status);
  const phase = usePomodoro((s) => s.phase);
  const justFinished = usePomodoro((s) => s.justFinished);

  useEffect(() => {
    if (status === "running" || status === "paused") {
      const tag = phase === "focus" ? "专注" : "休息";
      document.title = `${formatMmSs(remainingMs)} · ${tag}`;
    } else if (justFinished) {
      document.title = "完成 · 樱时";
    } else {
      document.title = TITLE_IDLE;
    }
  }, [status, remainingMs, phase, justFinished]);

  return null;
}

function StatusLive() {
  const status = usePomodoro((s) => s.status);
  const phase = usePomodoro((s) => s.phase);
  const justFinished = usePomodoro((s) => s.justFinished);
  const text = justFinished
    ? "专注完成，准备休息"
    : status === "running"
      ? `正在${PHASE_LABEL[phase]}`
      : status === "paused"
        ? "已暂停"
        : "准备开始";
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

export function AppShell() {
  const status = usePomodoro((s) => s.status);
  const settingsOpen = usePomodoro((s) => s.settingsOpen);
  const theme = usePomodoro((s) => s.settings.theme);
  const wakeLockOn = usePomodoro((s) => s.settings.wakeLock);
  const charState = usePomodoro(selectCharState);
  const justFinished = usePomodoro((s) => s.justFinished);
  const startBreak = usePomodoro((s) => s.startBreak);

  useEffect(() => {
    const api = usePomodoro.persist;
    const done = () => usePomodoro.getState().tick();
    if (!api?.rehydrate) {
      done();
      return;
    }
    const t = window.setTimeout(done, 400);
    void Promise.resolve(api.rehydrate()).finally(() => {
      window.clearTimeout(t);
      done();
    });
  }, []);

  useEffect(() => {
    const tick = () => usePomodoro.getState().tick();
    const id = window.setInterval(tick, 250);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        resumeAudio();
        // Pull any peer-tab writes first — its post-hydration hook runs
        // tick() on MERGED state. A synchronous tick here would complete an
        // expired timer against the stale pre-merge base, and the merge's
        // max-join would then collapse that count away.
        void usePomodoro.persist.rehydrate?.();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, []);

  useEffect(() => {
    const apply = () => {
      const dark =
        theme === "dark" ||
        (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    if (status !== "running" || !wakeLockOn) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    let sentinel: { release: () => Promise<void> } | null = null;
    let released = false;

    const request = async () => {
      if (released || !nav.wakeLock) return;
      try {
        const s = await nav.wakeLock.request("screen");
        if (released) {
          void s.release();
          return;
        }
        // Overlapping re-request (the browser auto-releases the old
        // sentinel on hide) — replace and release whichever we held.
        const prev = sentinel;
        sentinel = s;
        if (prev) void prev.release();
      } catch {
        sentinel = null;
      }
    };
    void request();
    const onVis = () => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVis);
      void sentinel?.release();
    };
  }, [status, wakeLockOn]);

  useEffect(() => {
    if (!justFinished) return;
    const t = window.setTimeout(() => startBreak(), 2800);
    return () => window.clearTimeout(t);
  }, [justFinished, startBreak]);

  useEffect(() => {
    const unlock = () => resumeAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  // iOS Safari starves cross-origin iframes of touch/click delivery unless
  // the document itself holds a touch listener — delegated handlers on the
  // React root element alone are not enough. A passive no-op is sufficient.
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    document.addEventListener("touchend", noop, { passive: true });
    installPressGuards();
    return () => {
      document.removeEventListener("touchstart", noop);
      document.removeEventListener("touchend", noop);
    };
  }, []);

  // localStorage writes are whole-snapshot; a storage event means another
  // tab changed something — rehydrate merges logs/tasks additively instead
  // of letting the slower tab clobber counts on its next write. Skip when
  // the incoming value already equals our own persisted slice — without
  // this echo-check two tabs would write-loop forever.
  useEffect(() => {
    // Incoming slices already merged once. Skipping a repeat is safe —
    // merge is deterministic, so re-merging the same bytes can only
    // reproduce the result we already wrote — and it bounds the whole
    // merge+write-back path against a stale-build peer whose canonical
    // form differs from ours (each distinct slice costs one reply max).
    const seenIncoming = new Set<string>();
    const onStorage = (e: StorageEvent) => {
      // e.key === null means a peer's localStorage.clear() — merging an
      // empty snapshot would half-reset our state, and our next write
      // repopulates storage anyway. Only our own key matters.
      if (e.key !== STORAGE_KEY) return;
      const slice = () => {
        const partialize = usePomodoro.persist.getOptions().partialize;
        return JSON.stringify(
          partialize
            ? partialize(usePomodoro.getState())
            : usePomodoro.getState(),
        );
      };
      let incomingSlice: string | null = null;
      if (e.newValue) {
        try {
          incomingSlice = JSON.stringify(
            (JSON.parse(e.newValue) as { state?: unknown }).state ?? null,
          );
          if (incomingSlice === slice() || seenIncoming.has(incomingSlice)) {
            return;
          }
          seenIncoming.add(incomingSlice);
          if (seenIncoming.size > 32) seenIncoming.clear();
        } catch {
          /* unparseable payload — fall through to rehydrate */
        }
      }
      void Promise.resolve(usePomodoro.persist.rehydrate?.()).then(() => {
        // Rehydrate merges but does NOT write back (persist's internal set
        // is unpersisted for same-version records), so a snapshot that
        // LOST merge conflict resolution would linger in storage and win
        // on the next load. If our converged slice differs, force a write
        // (api.setState wraps persist's setItem). seenIncoming bounds the
        // whole path: each distinct incoming form triggers at most one
        // merge + one reply, so a stale-build peer whose canonical form
        // differs can't ping-pong writes forever.
        if (incomingSlice != null && incomingSlice !== slice()) {
          usePomodoro.setState((s) => ({ ...s }));
        }
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <div className="app-frame">
      <DocumentTitle />
      <StatusLive />
      <div className="sky" />
      <Petals />
      <main className="app-grid relative z-10" inert={settingsOpen}>
        <section className="char-pane relative min-h-0">
          <CharacterStage state={charState} />
        </section>
        <section className="panel-pane min-h-0">
          <TimerPanel />
        </section>
      </main>
      <SettingsSheet />
    </div>
  );
}
