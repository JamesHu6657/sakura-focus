import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { lastNDates, todayKey, uid } from "@/lib/utils";
import { playEndChime, playStartChime } from "./audio";
import {
  DEFAULT_SETTINGS,
  MAX_TASKS,
  STORAGE_KEY,
  type CharState,
  type Phase,
  type Settings,
  type Task,
  type TimerStatus,
} from "./types";

function durationFor(phase: Phase, settings: Settings): number {
  const min =
    phase === "focus"
      ? settings.focusMin
      : phase === "shortBreak"
        ? settings.shortBreakMin
        : settings.longBreakMin;
  return Math.max(1, min) * 60 * 1000;
}

function nextBreak(focusCompleted: number, every: number): Phase {
  const n = Math.max(2, every);
  return focusCompleted > 0 && focusCompleted % n === 0 ? "longBreak" : "shortBreak";
}

function pruneLogs(logs: Record<string, number>): Record<string, number> {
  const keep = new Set(lastNDates(42));
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(logs)) {
    if (keep.has(k)) next[k] = v;
  }
  return next;
}

function fireNotify(title: string, body: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    if (usePomodoro.getState().settings.notify === false) return;
    new Notification(title, { body, silent: true, icon: "/assets/char-done.png" });
  } catch {
    /* Safari may reject when not in a gesture */
  }
}

export async function requestNotifyPerm() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
}

function idleFocusPatch(settings: Settings): Partial<PomodoroState> {
  const durationMs = durationFor("focus", settings);
  return {
    status: "idle",
    phase: "focus",
    durationMs,
    remainingMs: durationMs,
    endsAt: null,
    justFinished: false,
  };
}

export interface PomodoroState {
  settings: Settings;
  tasks: Task[];
  logs: Record<string, number>;
  status: TimerStatus;
  phase: Phase;
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
  focusCompleted: number;
  justFinished: boolean;
  activeTaskId: string | null;
  settingsOpen: boolean;

  tick: () => void;
  startFocus: () => void;
  startBreak: () => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  reset: () => void;
  completePhase: (skipped: boolean) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  addTask: (title: string) => void;
  updateTask: (id: string, patch: Partial<Pick<Task, "title" | "done">>) => void;
  removeTask: (id: string) => void;
  setActiveTask: (id: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
}

type Persisted = Pick<
  PomodoroState,
  | "settings"
  | "tasks"
  | "logs"
  | "status"
  | "phase"
  | "durationMs"
  | "remainingMs"
  | "endsAt"
  | "focusCompleted"
  | "activeTaskId"
>;

export const usePomodoro = create<PomodoroState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      tasks: [],
      logs: {},
      status: "idle",
      phase: "focus",
      durationMs: DEFAULT_SETTINGS.focusMin * 60 * 1000,
      remainingMs: DEFAULT_SETTINGS.focusMin * 60 * 1000,
      endsAt: null,
      focusCompleted: 0,
      justFinished: false,
      activeTaskId: null,
      settingsOpen: false,

      tick: () => {
        const s = get();
        if (s.status !== "running" || s.endsAt == null) return;
        if (Date.now() >= s.endsAt) get().completePhase(false);
      },

      startFocus: () => {
        const s = get();
        if (s.settings.notify !== false) void requestNotifyPerm();
        playStartChime(s.settings.muted);
        const durationMs = durationFor("focus", s.settings);
        set({
          status: "running",
          phase: "focus",
          durationMs,
          remainingMs: durationMs,
          endsAt: Date.now() + durationMs,
          justFinished: false,
        });
      },

      startBreak: () => {
        const s = get();
        const phase = nextBreak(s.focusCompleted, s.settings.longBreakEvery);
        playStartChime(s.settings.muted);
        const durationMs = durationFor(phase, s.settings);
        set({
          status: "running",
          phase,
          durationMs,
          remainingMs: durationMs,
          endsAt: Date.now() + durationMs,
          justFinished: false,
        });
      },

      pause: () => {
        const s = get();
        if (s.status !== "running") return;
        const rem = s.endsAt != null ? Math.max(0, s.endsAt - Date.now()) : s.remainingMs;
        set({ status: "paused", remainingMs: rem, endsAt: null });
      },

      resume: () => {
        const s = get();
        if (s.status !== "paused") return;
        set({ status: "running", endsAt: Date.now() + s.remainingMs });
      },

      skip: () => {
        const s = get();
        if (s.justFinished) {
          // Tomato already counted — skip the upcoming rest.
          set(idleFocusPatch(s.settings));
          return;
        }
        if (s.phase === "focus" && s.status !== "idle") {
          playEndChime(s.settings.muted);
          fireNotify("已跳过专注", "先休息一下。");
          const phase: Phase = "shortBreak";
          const durationMs = durationFor(phase, s.settings);
          set({
            status: "running",
            phase,
            durationMs,
            remainingMs: durationMs,
            endsAt: Date.now() + durationMs,
            justFinished: false,
          });
          return;
        }
        get().completePhase(true);
      },

      reset: () => {
        set(idleFocusPatch(get().settings));
      },

      completePhase: (skipped) => {
        const s = get();
        const wasFocus = s.phase === "focus";
        playEndChime(s.settings.muted);

        if (wasFocus && !skipped && s.status !== "idle") {
          const key = todayKey();
          const logs = pruneLogs({ ...s.logs, [key]: (s.logs[key] ?? 0) + 1 });
          const tasks = s.activeTaskId
            ? s.tasks.map((t) => (t.id === s.activeTaskId ? { ...t, tomatoes: t.tomatoes + 1 } : t))
            : s.tasks;
          const focusCompleted = s.focusCompleted + 1;
          fireNotify("专注完成", "休息一下吧，你已经很棒了。");
          set({
            logs,
            tasks,
            focusCompleted,
            justFinished: true,
            status: "idle",
            remainingMs: 0,
            endsAt: null,
          });
          return;
        }

        if (wasFocus && skipped) {
          fireNotify("已跳过专注", "下一轮随时开始。");
          set(idleFocusPatch(s.settings));
          return;
        }

        fireNotify(skipped ? "休息结束" : "休息好了", "准备好就开始下一颗番茄。");
        set(idleFocusPatch(s.settings));
      },

      patchSettings: (patch) => {
        const s = get();
        const settings = { ...s.settings, ...patch };
        const next: Partial<PomodoroState> = { settings };
        if (s.status === "idle" && !s.justFinished) {
          const durationMs = durationFor(s.phase, settings);
          next.durationMs = durationMs;
          next.remainingMs = durationMs;
        }
        set(next);
      },

      addTask: (title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        const task: Task = {
          id: uid(),
          title: trimmed,
          done: false,
          tomatoes: 0,
          createdAt: Date.now(),
        };
        set((s) => ({
          tasks: [task, ...s.tasks].slice(0, MAX_TASKS),
          activeTaskId: s.activeTaskId ?? task.id,
        }));
      },

      updateTask: (id, patch) => {
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        }));
      },

      removeTask: (id) => {
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== id),
          activeTaskId: s.activeTaskId === id ? null : s.activeTaskId,
        }));
      },

      setActiveTask: (id) => set({ activeTaskId: id }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
    }),
    {
      name: STORAGE_KEY,
      skipHydration: true,
      storage: createJSONStorage(() => {
        const memory = { data: null as string | null };
        const fallback = {
          getItem: () => memory.data,
          setItem: (_k: string, v: string) => {
            memory.data = v;
          },
          removeItem: () => {
            memory.data = null;
          },
        };
        if (typeof window === "undefined") return fallback;
        try {
          const ls = window.localStorage;
          return {
            getItem: (k: string) => {
              try {
                return ls.getItem(k);
              } catch {
                return memory.data;
              }
            },
            setItem: (k: string, v: string) => {
              memory.data = v;
              try {
                ls.setItem(k, v);
              } catch {
                /* private iframe */
              }
            },
            removeItem: (k: string) => {
              memory.data = null;
              try {
                ls.removeItem(k);
              } catch {
                /* ignore */
              }
            },
          };
        } catch {
          return fallback;
        }
      }),
      partialize: (s): Persisted => ({
        settings: s.settings,
        tasks: s.tasks,
        logs: s.logs,
        status: s.status,
        phase: s.phase,
        durationMs: s.durationMs,
        remainingMs: s.remainingMs,
        endsAt: s.endsAt,
        focusCompleted: s.focusCompleted,
        activeTaskId: s.activeTaskId,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>;
        const settings = { ...DEFAULT_SETTINGS, ...p.settings };
        if (current.status !== "idle" || current.justFinished) {
          return {
            ...current,
            settings,
            tasks: p.tasks ?? current.tasks,
            logs: p.logs ?? current.logs,
            focusCompleted: p.focusCompleted ?? current.focusCompleted,
            activeTaskId: p.activeTaskId ?? current.activeTaskId,
          };
        }
        return {
          ...current,
          ...p,
          settings,
          justFinished: false,
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.status === "idle" && state.remainingMs <= 0) {
          usePomodoro.setState(idleFocusPatch(state.settings));
          return;
        }
        state.tick();
      },
    },
  ),
);

export function selectCharState(s: PomodoroState): CharState {
  if (s.justFinished) return "done";
  if (s.status === "idle") return "idle";
  if (s.phase === "focus") return "focus";
  return "rest";
}

export const PHASE_LABEL: Record<Phase, string> = {
  focus: "专注",
  shortBreak: "短休息",
  longBreak: "长休息",
};
