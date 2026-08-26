import { useEffect } from "react";
import { formatMmSs } from "@/lib/utils";
import { resumeAudio } from "@/lib/pomodoro/audio";
import { PHASE_LABEL, selectCharState, usePomodoro } from "@/lib/pomodoro/store";
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
      if (document.visibilityState === "visible") resumeAudio();
      tick();
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
        sentinel = await nav.wakeLock.request("screen");
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

  return (
    <div className="app-frame">
      <DocumentTitle />
      <StatusLive />
      <div className="sky" />
      <Petals />
      <main className="app-grid relative z-10">
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
