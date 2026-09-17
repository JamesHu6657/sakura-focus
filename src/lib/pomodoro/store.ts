import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { lastNDates, todayKey, uid } from "@/lib/utils";
import { playEndChime, playStartChime } from "./audio";
import {
  DEFAULT_SETTINGS,
  MAX_TASKS,
  STORAGE_KEY,
  type CharState,
  type CountedEnd,
  type Phase,
  type Settings,
  type Task,
  type TimerStatus,
  type Tombstone,
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
  /** Focuses already counted — cross-tab dedup guard. A set (not a
   *  scalar) because tabs can count different deadlines in different
   *  orders; membership survives any merge order. Each entry stores the
   *  day it was logged under so merge's count-floor survives TZ moves. */
  countedEndsAts: CountedEnd[];
  /** Deleted tasks — lets a delete win over a peer's stale copy. `at`
   *  orders eviction by recency under the cap. */
  tombstones: Tombstone[];
  /** Lamport-style clock over the timer slice (status/phase/endsAt/…).
   *  Bumped on every timer transition; merge adopts the side with the
   *  higher rev, so two tabs converge deterministically instead of
   *  flip-flopping on crossed writes — and a deliberate reset (idle with a
   *  newer rev) can propagate onto a tab that still holds a timer. */
  timerRev: number;
  /** Same idea for settings — without it a wholesale settings adopt makes
   *  two tabs with divergent settings echo-write each other's forever. */
  settingsRev: number;
  /** Same for the selected task — a bare "remote-preferred" merge is not
   *  commutative (two simultaneous picks swap-and-stick), and a deliberate
   *  clear (null) needs a rev to win over a peer's selection. */
  activeTaskRev: number;

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
  | "countedEndsAts"
  | "tombstones"
  | "timerRev"
  | "settingsRev"
  | "activeTaskRev"
>;

const COUNTED_CAP = 100;
const TOMBSTONE_CAP = 100;

/** Canonical orderings shared by merge output and partialize — the storage
 *  echo-check compares serialized bytes, so every writer must emit
 *  equivalent states identically or tabs keep rehydrating each other. */
const sortLogs = (o: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(o)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(-60),
  );

const sortTasks = (list: Task[]) =>
  [...list]
    // Numeric guard keeps the comparator transitive — a missing/NaN
    // createdAt would otherwise make sort output order-dependent.
    .sort(
      (a, b) =>
        (Number.isFinite(b.createdAt) ? b.createdAt : 0) -
          (Number.isFinite(a.createdAt) ? a.createdAt : 0) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_TASKS);

const sortCounted = (list: CountedEnd[]) =>
  [...list].sort((a, b) => a.at - b.at).slice(-COUNTED_CAP);

/** Canonical tombstone list: dedupe by id keeping the newest `at`, cap by
 *  recency, emit sorted by id. */
const sortTombstones = (list: Tombstone[]) => {
  const byId = new Map<string, Tombstone>();
  for (const t of list) {
    const prev = byId.get(t.id);
    if (!prev || t.at > prev.at) byId.set(t.id, t);
  }
  return [...byId.values()]
    // Total order: an `at` tie must not fall back to insertion order —
    // each tab's own list is prepended, so tied entries would evict
    // different ids on different tabs and diverge forever.
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, TOMBSTONE_CAP)
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** Was this deadline already counted? Once the dedup window is full,
 *  anything older than the oldest retained marker is assumed counted —
 *  otherwise a persistent stale snapshot would re-bank it on every
 *  rehydrate, inflating the count without bound. */
function wasCounted(list: CountedEnd[], endsAt: number): boolean {
  if (list.some((c) => c.at === endsAt)) return true;
  return list.length >= COUNTED_CAP && endsAt < list[0].at;
}

const PHASE_RANK: Record<Phase, number> = { focus: 0, shortBreak: 1, longBreak: 2 };

function isPhase(v: unknown): v is Phase {
  return v === "focus" || v === "shortBreak" || v === "longBreak";
}

/** Deterministic total order over timer states for same-rev merge ties:
 *  smaller wins. The MORE ACTIVE state wins — running < paused < idle —
 *  because a same-rev idle/paused writer almost always just doesn't know
 *  about our timer (a deliberate reset or pause bumps the rev and wins
 *  strictly, never needing the tie-break). Within a status, the earlier
 *  deadline (endsAt / remainingMs) wins; phase + durationMs finish the
 *  order so two slices equal on the first two keys can't diverge forever
 *  (which would write-loop the storage echo check). */
function timerRank(s: {
  status: TimerStatus;
  endsAt: number | null;
  remainingMs: number;
  phase: Phase;
  durationMs: number;
}): readonly [number, number, number, number, number, number] {
  const rank = s.status === "running" ? 0 : s.status === "paused" ? 1 : 2;
  const when = s.status === "running" ? (s.endsAt ?? Infinity) : s.remainingMs;
  return [
    rank,
    Number.isFinite(when) ? when : Infinity,
    PHASE_RANK[s.phase] ?? 0,
    Number.isFinite(s.durationMs) ? s.durationMs : Infinity,
    // The field not used as `when` still needs a rank — otherwise two
    // same-rev slices differing only in it tie forever and diverge.
    Number.isFinite(s.remainingMs) ? s.remainingMs : Infinity,
    Number.isFinite(s.endsAt) ? (s.endsAt as number) : -1,
  ];
}

function timerRankLt(
  a: Parameters<typeof timerRank>[0],
  b: Parameters<typeof timerRank>[0],
): boolean {
  const ra = timerRank(a);
  const rb = timerRank(b);
  for (let i = 0; i < 6; i++) {
    if (ra[i] !== rb[i]) return ra[i] < rb[i];
  }
  return false;
}

/** Same for settings at equal settingsRev — the serialized blob compare is
 *  deterministic, so both tabs pick the same winner and converge. */
function settingsLt(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) < JSON.stringify(b);
}

const SETTING_RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  focusMin: [1, 180],
  shortBreakMin: [1, 60],
  longBreakMin: [1, 120],
  longBreakEvery: [2, 12],
};

/** Persisted settings can be hand-edited/corrupt — coerce each key against
 *  the defaults' types and clamp ranges so a garbage focusMin can't turn
 *  durationFor NaN or produce an unkillable 69-day timer. */
function sanitizeSettings(v: unknown): Settings | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const val = src[k];
    const dflt = DEFAULT_SETTINGS[k];
    const range = SETTING_RANGES[k];
    if (typeof dflt === "boolean" && typeof val === "boolean") {
      (out as Record<keyof Settings, unknown>)[k] = val;
    } else if (
      typeof dflt === "number" &&
      typeof val === "number" &&
      Number.isFinite(val)
    ) {
      (out as Record<keyof Settings, unknown>)[k] = range
        ? Math.min(range[1], Math.max(range[0], val))
        : val;
    } else if (k === "theme" && (val === "system" || val === "light" || val === "dark")) {
      out.theme = val;
    }
  }
  return out;
}

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
      countedEndsAts: [],
      tombstones: [],
      timerRev: 0,
      settingsRev: 0,
      activeTaskRev: 0,

      tick: () => {
        const s = get();
        if (s.status !== "running") return;
        // Self-heal a corrupt "running with no deadline" snapshot.
        if (s.endsAt == null) {
          set({ status: "paused", timerRev: s.timerRev + 1 });
          return;
        }
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
          timerRev: s.timerRev + 1,
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
          timerRev: s.timerRev + 1,
        });
      },

      pause: () => {
        const s = get();
        if (s.status !== "running") return;
        const rem = s.endsAt != null ? Math.max(0, s.endsAt - Date.now()) : s.remainingMs;
        // Tapping pause on a timer that already expired should complete it,
        // not freeze it at 00:00 paused forever.
        if (s.endsAt != null && rem <= 0) {
          get().completePhase(false);
          return;
        }
        set({
          status: "paused",
          remainingMs: rem,
          endsAt: null,
          timerRev: s.timerRev + 1,
        });
      },

      resume: () => {
        const s = get();
        if (s.status !== "paused") return;
        set({
          status: "running",
          endsAt: Date.now() + s.remainingMs,
          timerRev: s.timerRev + 1,
        });
      },

      skip: () => {
        const s = get();
        // Idle with nothing to skip: falling through to completePhase
        // would bump timerRev on a no-op — a phantom rev that outranks a
        // peer's equal-rev running timer for no reason.
        if (s.status === "idle" && !s.justFinished) return;
        if (s.justFinished) {
          // Tomato already counted — skip the upcoming rest.
          set({ ...idleFocusPatch(s.settings), timerRev: s.timerRev + 1 });
          return;
        }
        if (s.phase === "focus" && s.status !== "idle") {
          // The timer may have expired while the tab was throttled —
          // completePhase runs on the next tick/visibility event, but a
          // skip landing in that gap must not lose the finished pomodoro:
          // bank it (once — wasCounted guards cross-tab dupes), then break.
          const expiredAt = s.endsAt != null && Date.now() >= s.endsAt
            ? s.endsAt
            : null;
          const countable =
            expiredAt != null && !wasCounted(s.countedEndsAts, expiredAt);
          const dayKey = todayKey(new Date(expiredAt ?? Date.now()));
          playEndChime(s.settings.muted);
          fireNotify("已跳过专注", "先休息一下。");
          const phase = nextBreak(
            s.focusCompleted + (countable ? 1 : 0),
            s.settings.longBreakEvery,
          );
          const durationMs = durationFor(phase, s.settings);
          set({
            logs: countable
              ? pruneLogs({ ...s.logs, [dayKey]: (s.logs[dayKey] ?? 0) + 1 })
              : s.logs,
            tasks:
              countable && s.activeTaskId
                ? s.tasks.map((t) =>
                    t.id === s.activeTaskId
                      ? { ...t, tomatoes: t.tomatoes + 1 }
                      : t,
                  )
                : s.tasks,
            focusCompleted: s.focusCompleted + (countable ? 1 : 0),
            countedEndsAts:
              countable && expiredAt != null
                ? sortCounted([
                    ...s.countedEndsAts,
                    {
                      at: expiredAt,
                      day: dayKey,
                      taskId: s.activeTaskId ?? null,
                    },
                  ])
                : s.countedEndsAts,
            status: "running",
            phase,
            durationMs,
            remainingMs: durationMs,
            endsAt: Date.now() + durationMs,
            justFinished: false,
            timerRev: s.timerRev + 1,
          });
          return;
        }
        get().completePhase(true);
      },

      reset: () => {
        const s = get();
        // Same throttle-gap hole as skip: a focus that already expired
        // earned its tomato — bank it silently before discarding the timer.
        const expiredAt =
          s.phase === "focus" &&
          s.status === "running" &&
          s.endsAt != null &&
          Date.now() >= s.endsAt
            ? s.endsAt
            : null;
        const countable =
          expiredAt != null && !wasCounted(s.countedEndsAts, expiredAt);
        const dayKey = todayKey(new Date(expiredAt ?? Date.now()));
        set({
          ...idleFocusPatch(s.settings),
          logs: countable
            ? pruneLogs({ ...s.logs, [dayKey]: (s.logs[dayKey] ?? 0) + 1 })
            : s.logs,
          tasks:
            countable && s.activeTaskId
              ? s.tasks.map((t) =>
                  t.id === s.activeTaskId
                    ? { ...t, tomatoes: t.tomatoes + 1 }
                    : t,
                )
              : s.tasks,
          focusCompleted: s.focusCompleted + (countable ? 1 : 0),
          countedEndsAts:
            countable && expiredAt != null
              ? sortCounted([
                  ...s.countedEndsAts,
                  { at: expiredAt, day: dayKey, taskId: s.activeTaskId ?? null },
                ])
              : s.countedEndsAts,
          timerRev: s.timerRev + 1,
        });
      },

      completePhase: (skipped) => {
        const s = get();
        const wasFocus = s.phase === "focus";

        if (
          wasFocus &&
          !skipped &&
          s.status === "running" &&
          s.endsAt != null
        ) {
          // Another tab can run the same persisted timer — count its endsAt
          // once, no matter how many tabs complete it. A second completion
          // also skips the chime/notification it already played.
          const alreadyCounted =
            s.endsAt != null && wasCounted(s.countedEndsAts, s.endsAt);
          if (!alreadyCounted) {
            playEndChime(s.settings.muted);
            fireNotify("专注完成", "休息一下吧，你已经很棒了。");
          }
          // Attribute to the day the timer ended (same rule as the banked
          // and silent-expire paths) so a midnight straddle can't split
          // one completion across two day keys on different tabs.
          const key = todayKey(s.endsAt != null ? new Date(s.endsAt) : new Date());
          set({
            logs: alreadyCounted
              ? s.logs
              : pruneLogs({ ...s.logs, [key]: (s.logs[key] ?? 0) + 1 }),
            tasks:
              !alreadyCounted && s.activeTaskId
                ? s.tasks.map((t) =>
                    t.id === s.activeTaskId ? { ...t, tomatoes: t.tomatoes + 1 } : t,
                  )
                : s.tasks,
            focusCompleted: alreadyCounted ? s.focusCompleted : s.focusCompleted + 1,
            countedEndsAts:
              s.endsAt != null && !alreadyCounted
                ? sortCounted([
                    ...s.countedEndsAts,
                    { at: s.endsAt, day: key, taskId: s.activeTaskId ?? null },
                  ])
                : s.countedEndsAts,
            justFinished: true,
            status: "idle",
            remainingMs: 0,
            endsAt: null,
            timerRev: s.timerRev + 1,
          });
          return;
        }

        playEndChime(s.settings.muted);
        if (wasFocus && skipped) {
          fireNotify("已跳过专注", "下一轮随时开始。");
          set({ ...idleFocusPatch(s.settings), timerRev: s.timerRev + 1 });
          return;
        }

        fireNotify(skipped ? "休息结束" : "休息好了", "准备好就开始下一颗番茄。");
        set({ ...idleFocusPatch(s.settings), timerRev: s.timerRev + 1 });
      },

      patchSettings: (patch) => {
        const s = get();
        const settings = { ...s.settings, ...patch };
        // settingsRev bumps on ANY settings change — merge picks the
        // higher rev, so concurrent edits on two tabs converge instead of
        // echoing each other's snapshots forever.
        const next: Partial<PomodoroState> = {
          settings,
          settingsRev: s.settingsRev + 1,
        };
        if (s.status === "idle" && !s.justFinished) {
          const durationMs = durationFor(s.phase, settings);
          if (durationMs !== s.durationMs) {
            // The timer slice actually changed — bump timerRev so a peer
            // adopts it wholesale instead of tie-breaking a stale
            // remainingMs. Only bump on a REAL change: a no-op bump would
            // let an idle tab's mute toggle kill a peer's running timer.
            next.durationMs = durationMs;
            next.remainingMs = durationMs;
            next.timerRev = s.timerRev + 1;
          }
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
          updatedAt: Date.now(),
        };
        set((s) => {
          const tasks = [task, ...s.tasks].slice(0, MAX_TASKS);
          // If the cap evicted the active task, fall forward to the new one
          // instead of leaving a dangling id that can never earn tomatoes.
          const activeTaskId = tasks.some((t) => t.id === s.activeTaskId)
            ? s.activeTaskId
            : task.id;
          return activeTaskId === s.activeTaskId
            ? { tasks }
            : { tasks, activeTaskId, activeTaskRev: s.activeTaskRev + 1 };
        });
      },

      updateTask: (id, patch) => {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t,
          ),
        }));
      },

      removeTask: (id) => {
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== id),
          activeTaskId: s.activeTaskId === id ? null : s.activeTaskId,
          activeTaskRev:
            s.activeTaskId === id ? s.activeTaskRev + 1 : s.activeTaskRev,
          // Tombstone the id so a peer's stale snapshot can't resurrect it.
          tombstones: [...s.tombstones, { id, at: Date.now() }].slice(-TOMBSTONE_CAP),
        }));
      },

      setActiveTask: (id) =>
        set((s) =>
          s.activeTaskId === id
            ? {}
            : { activeTaskId: id, activeTaskRev: s.activeTaskRev + 1 },
        ),
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
      // Canonical serialization: producers append/prepend in arbitrary
      // order, but the echo-check in AppShell byte-compares this output
      // against a peer's write — emit every collection in merge's order.
      partialize: (s): Persisted => ({
        settings: s.settings,
        tasks: sortTasks(s.tasks),
        logs: sortLogs(s.logs),
        status: s.status,
        phase: s.phase,
        durationMs: s.durationMs,
        remainingMs: s.remainingMs,
        endsAt: s.endsAt,
        focusCompleted: s.focusCompleted,
        activeTaskId: s.activeTaskId,
        countedEndsAts: sortCounted(s.countedEndsAts),
        tombstones: sortTombstones(s.tombstones),
        timerRev: s.timerRev,
        settingsRev: s.settingsRev,
        activeTaskRev: s.activeTaskRev,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>;
        // Settings join: a plain spread-adopt would ping-pong writes
        // between tabs holding divergent settings (each merge writes, so
        // the peer re-merges the other's settings back). Last-writer-wins
        // by settingsRev; equal revs pick the same winner on both sides
        // via a deterministic serialized compare. A pre-rev snapshot
        // (settingsRev absent) is adopted only onto a virgin store —
        // on a live store it would clobber newer settings forever.
        const remoteSettings = sanitizeSettings(p.settings);
        const settings =
          remoteSettings == null
            ? current.settings
            : p.settingsRev == null
              ? current.settingsRev === 0
                ? remoteSettings
                : current.settings
              : (p.settingsRev ?? 0) > current.settingsRev ||
                  (p.settingsRev === current.settingsRev &&
                    settingsLt(current.settings, remoteSettings))
                ? remoteSettings
                : current.settings;
        // Whole-snapshot persist has no conflict resolution, so merge
        // additively: another tab's write must never clobber this tab's
        // counts or tasks (rehydrate also runs on cross-tab storage events).
        // Every merged collection is emitted in a CANONICAL order — the
        // AppShell echo-check compares serialized bytes, so equivalent
        // states must stringify identically or tabs write-loop forever.
        const logMap: Record<string, number> = { ...current.logs };
        if (p.logs && typeof p.logs === "object") {
          for (const [k, v] of Object.entries(p.logs)) {
            if (typeof v === "number" && Number.isFinite(v)) {
              logMap[k] = Math.max(logMap[k] ?? 0, v);
            }
          }
        }
        // Canonical: sorted keys, bounded size. No clock-dependent prune
        // here — pruneLogs' 42-day window differs across timezones and
        // would toggle keys off/on forever between two tabs.
        let logs = sortLogs(logMap);
        // Tombstones union by id, keeping the newest `at`; the cap evicts
        // by recency (not random-id sort order, which could drop a fresh
        // delete first and resurrect the task via a peer's stale copy).
        // Legacy string ids coerce to at:0 — oldest, first out.
        const coerceTombstone = (v: unknown): Tombstone | null => {
          if (typeof v === "string") return { id: v, at: 0 };
          if (
            v != null &&
            typeof v === "object" &&
            typeof (v as Tombstone).id === "string"
          ) {
            const at = (v as Tombstone).at;
            return { id: (v as Tombstone).id, at: Number.isFinite(at) ? at : 0 };
          }
          return null;
        };
        const tombstoneList = sortTombstones([
          ...current.tombstones,
          ...(Array.isArray(p.tombstones) ? p.tombstones : []),
        ]
          .map(coerceTombstone)
          .filter((t): t is Tombstone => t != null));
        const tombstones = new Set(tombstoneList.map((t) => t.id));
        // Same task in two tabs: newest-updatedAt wins for title/done, but
        // tomatoes take the max so concurrent completions on either copy
        // both survive. Equal-updatedAt divergence breaks deterministically
        // on content so both tabs pick the same copy. Tombstoned ids stay
        // deleted.
        const byId = new Map<string, Task>();
        const remoteTasks = Array.isArray(p.tasks) ? p.tasks : [];
        for (const t of [...current.tasks, ...remoteTasks]) {
          if (!t || typeof t.id !== "string") continue;
          const prev = byId.get(t.id);
          if (!prev) {
            byId.set(t.id, t);
          } else {
            // Coerce to finite numbers — a corrupt updatedAt compares false
            // in BOTH directions (non-total order → non-commutative merge),
            // and a string tomatoes feeds NaN into Math.max permanently.
            const ta = Number.isFinite(t.updatedAt) ? t.updatedAt : 0;
            const tb = Number.isFinite(prev.updatedAt) ? prev.updatedAt : 0;
            const winner =
              ta !== tb
                ? ta > tb ? t : prev
                : JSON.stringify(t) >= JSON.stringify(prev) ? t : prev;
            const tomatoes = Math.max(
              Number.isFinite(prev.tomatoes) ? prev.tomatoes : 0,
              Number.isFinite(t.tomatoes) ? t.tomatoes : 0,
            );
            byId.set(t.id, { ...winner, tomatoes });
          }
        }
        let tasks = sortTasks([...byId.values()].filter((t) => !tombstones.has(t.id)));
        // The only unvalidated scalar would poison Math.max with NaN —
        // unrecoverable in-session (NaN < n is false, floors can't fix).
        let focusCompleted = Math.max(
          current.focusCompleted,
          typeof p.focusCompleted === "number" &&
            Number.isFinite(p.focusCompleted)
            ? p.focusCompleted
            : 0,
        );
        // Union by `at`. Legacy snapshots stored bare numbers — coerce to
        // {at, day} once (day recomputed in the local TZ; a one-time edge).
        // On an at-collision with different day/taskId, keep the
        // deterministically-smaller record so both tabs pick the same one.
        const countedByAt = new Map<number, CountedEnd>();
        // Records that lose an at-collision still had their side-effects
        // applied pre-merge (the banking tab already +1'd its task). Track
        // losing taskIds so a divergent activeTaskId at completion time
        // can't leave a permanent phantom tomato — the decrement below is
        // computed from the same union on every tab, so it converges.
        const lostCredit = new Map<string, number>();
        // Same for the day dimension: two tabs in different timezones can
        // attribute the same endsAt to different calendar days — the union
        // keeps BOTH logs increments while only one marker survives. The
        // loser's day +1 is decremented below (clamped at its day floor).
        const lostDay = new Map<string, number>();
        const pushCounted = (v: unknown) => {
          let at: number | null = null;
          let day: string | null = null;
          let taskId: string | null = null;
          if (typeof v === "number" && Number.isFinite(v)) {
            at = v;
          } else if (
            v != null &&
            typeof v === "object" &&
            typeof (v as CountedEnd).at === "number" &&
            Number.isFinite((v as CountedEnd).at)
          ) {
            at = (v as CountedEnd).at;
            const d = (v as CountedEnd).day;
            if (typeof d === "string" && d) day = d;
            const tid = (v as CountedEnd).taskId;
            if (typeof tid === "string") taskId = tid;
          }
          if (at == null) return;
          const cand: CountedEnd = {
            at,
            day: day ?? todayKey(new Date(at)),
            taskId,
          };
          const prev = countedByAt.get(at);
          if (!prev || JSON.stringify(cand) < JSON.stringify(prev)) {
            countedByAt.set(at, cand);
            // prev loses; same-taskId collisions self-collapse under the
            // task max-join, only a different taskId needs the decrement.
            if (prev) {
              if (prev.taskId && prev.taskId !== cand.taskId) {
                lostCredit.set(prev.taskId, (lostCredit.get(prev.taskId) ?? 0) + 1);
              }
              if (prev.day !== cand.day) {
                lostDay.set(prev.day, (lostDay.get(prev.day) ?? 0) + 1);
              }
            }
          } else {
            if (cand.taskId && cand.taskId !== prev.taskId) {
              lostCredit.set(cand.taskId, (lostCredit.get(cand.taskId) ?? 0) + 1);
            }
            if (cand.day !== prev.day) {
              lostDay.set(cand.day, (lostDay.get(cand.day) ?? 0) + 1);
            }
          }
        };
        for (const v of current.countedEndsAts) pushCounted(v);
        if (Array.isArray(p.countedEndsAts)) {
          for (const v of p.countedEndsAts) pushCounted(v);
        }
        const countedEndsAts = sortCounted([...countedByAt.values()]);
        // activeTaskId joins by its own lamport — "remote-preferred" is not
        // commutative (two tabs picking different tasks simultaneously
        // would swap-and-stick). Higher rev wins outright; equal revs take
        // the lexicographically larger id so both sides pick identically.
        // A deliberate clear (null) bumps the rev so it CAN win; at equal
        // rev, "" collates below any real id, keeping a symmetric tie from
        // erasing a selection. Unversioned snapshots adopt only onto a
        // virgin store, like the other rev fields.
        const pActRev =
          typeof p.activeTaskRev === "number" && Number.isFinite(p.activeTaskRev)
            ? p.activeTaskRev
            : null;
        const remoteActive = p.activeTaskId ?? null;
        const adoptedRemoteActive =
          pActRev == null
            ? current.activeTaskRev === 0
            : pActRev > current.activeTaskRev ||
              (pActRev === current.activeTaskRev &&
                remoteActive !== null &&
                remoteActive > (current.activeTaskId ?? ""));
        const candActive = adoptedRemoteActive
          ? remoteActive
          : current.activeTaskId;
        const activeTaskId = tasks.some((t) => t.id === candActive)
          ? candActive
          : null;
        // Claim the remote rev only when its selection actually survived —
        // a corrupt {activeTaskRev: 9e15, activeTaskId: "gone"} must not
        // launder the rev while its dangling id was filtered to null.
        const activeTaskRev =
          adoptedRemoteActive && activeTaskId === remoteActive
            ? Math.max(current.activeTaskRev, pActRev ?? 0)
            : current.activeTaskRev;
        // Timer slice: last-writer-wins by timerRev — the peer that acted
        // most recently owns the timer, so crossed writes converge in one
        // hop and a deliberate reset (idle at a newer rev) can propagate.
        // Equal revs (e.g. two tabs started different timers before either
        // write landed) break deterministically on a total rank over the
        // persisted timer slice. A snapshot with no rev is adopted only
        // onto a virgin store — on first load it is the only source of
        // truth, but an unversioned write mid-session must not discard a
        // live timer.
        // Corrupt rev fields would poison Math.max / comparisons with NaN —
        // validate before use.
        const pTimerRev =
          typeof p.timerRev === "number" && Number.isFinite(p.timerRev)
            ? p.timerRev
            : null;
        const pSettingsRev =
          typeof p.settingsRev === "number" && Number.isFinite(p.settingsRev)
            ? p.settingsRev
            : null;
        const pStatus =
          p.status === "idle" || p.status === "running" || p.status === "paused"
            ? p.status
            : undefined;
        const pTimer = {
          status: pStatus ?? current.status,
          endsAt:
            typeof p.endsAt === "number" && Number.isFinite(p.endsAt)
              ? p.endsAt
              : null,
          remainingMs:
            typeof p.remainingMs === "number" && Number.isFinite(p.remainingMs)
              ? p.remainingMs
              : Infinity,
          phase: isPhase(p.phase) ? p.phase : current.phase,
          durationMs:
            typeof p.durationMs === "number" && Number.isFinite(p.durationMs)
              ? p.durationMs
              : current.durationMs,
        };
        // A snapshot with no timerRev (pre-rev app version / cleared record)
        // is adopted only onto a virgin store — first load, where it is the
        // only source of truth. On a live store an unversioned write must
        // not discard a running timer.
        const remoteWins =
          (pTimerRev == null && current.timerRev === 0) ||
          (pTimerRev != null &&
            (pTimerRev > current.timerRev ||
              (pTimerRev === current.timerRev &&
                pStatus != null &&
                timerRankLt(pTimer, current))));

        // Whichever timer slice loses is discarded — bank an expired-but-
        // uncounted focus on that side first, or the pomodoro disappears.
        // Symmetric: remoteWins banks `current` before adopting p; keeping
        // local banks `p` because its record lives only until the next
        // write by any tab erases it. Dedup on endsAt makes a double-bank
        // across tabs impossible.
        const bankExpired = (
          status: TimerStatus | undefined,
          phase: Phase | undefined,
          endsAt: unknown,
          taskId: string | null | undefined,
        ) => {
          if (
            status !== "running" ||
            phase !== "focus" ||
            typeof endsAt !== "number" ||
            !Number.isFinite(endsAt) ||
            Date.now() < endsAt ||
            wasCounted(countedEndsAts, endsAt)
          ) {
            return;
          }
          const key = todayKey(new Date(endsAt));
          logs = sortLogs({ ...logs, [key]: (logs[key] ?? 0) + 1 });
          focusCompleted += 1;
          countedEndsAts.push({ at: endsAt, day: key, taskId: taskId ?? null });
          countedEndsAts.sort((a, b) => a.at - b.at);
          if (countedEndsAts.length > COUNTED_CAP) {
            countedEndsAts.splice(0, countedEndsAts.length - COUNTED_CAP);
          }
          if (taskId) {
            tasks = tasks.map((t) =>
              t.id === taskId ? { ...t, tomatoes: t.tomatoes + 1 } : t,
            );
          }
        };
        if (remoteWins) {
          bankExpired(current.status, current.phase, current.endsAt, current.activeTaskId);
        } else {
          bankExpired(pStatus, p.phase, p.endsAt, p.activeTaskId ?? null);
        }
        // Floor: the max-join undercounts when two tabs each counted a
        // DISTINCT endsAt on the same day before seeing each other's write
        // (both wrote base+1 → max gives base+1, not base+2). Every entry
        // in countedEndsAts represents a real completion, so a day's count
        // can never be less than the dedup entries attributed to it. The
        // stored `day` (not a recomputed todayKey) keeps this correct
        // across timezone changes. The floor only ever raises values —
        // monotone in the join, so convergence is unaffected.
        const dayFloor = new Map<string, number>();
        for (const c of countedEndsAts) {
          dayFloor.set(c.day, (dayFloor.get(c.day) ?? 0) + 1);
        }
        for (const [k, n] of dayFloor) {
          if ((logs[k] ?? 0) < n) logs[k] = n;
        }
        // Cross-TZ collisions: the losing record's day +1 was really
        // applied on its tab — remove it, clamped at the surviving-marker
        // floor so a marker that propagated without credit can't eat a
        // legitimate count.
        for (const [day, n] of lostDay) {
          const floor = dayFloor.get(day) ?? 0;
          const cur = logs[day] ?? 0;
          if (cur > floor) logs[day] = Math.max(cur - n, floor);
        }
        logs = sortLogs(logs);
        if (focusCompleted < countedEndsAts.length) {
          focusCompleted = countedEndsAts.length;
        }
        // Same floor for per-task tomatoes — a credited {at, taskId} entry
        // means the task really earned it, so max-join collapse can't drop
        // concurrent completions on different tabs.
        const tomatoFloor = new Map<string, number>();
        for (const c of countedEndsAts) {
          if (typeof c.taskId === "string") {
            tomatoFloor.set(c.taskId, (tomatoFloor.get(c.taskId) ?? 0) + 1);
          }
        }
        if (tomatoFloor.size) {
          tasks = tasks.map((t) => {
            const f = tomatoFloor.get(t.id);
            return f != null && f > t.tomatoes ? { ...t, tomatoes: f } : t;
          });
        }
        // Clamped at the marker floor so a lost record that never had its
        // +1 applied (tombstoned task, marker propagated without credit)
        // can't eat a legitimate surviving-marker credit.
        if (lostCredit.size) {
          tasks = tasks.map((t) => {
            const lost = lostCredit.get(t.id);
            if (!lost) return t;
            const floor = tomatoFloor.get(t.id) ?? 0;
            const dec = Math.max(t.tomatoes - lost, floor);
            return dec === t.tomatoes ? t : { ...t, tomatoes: dec };
          });
        }
        const merged = {
          settings,
          // Claim the remote's rev only when its VALUE was adopted — a
          // corrupt high-rev record must not launder our rev upward while
          // its settings were rejected (peers' legit newer revs would be
          // silently reverted by our write).
          settingsRev:
            remoteSettings != null && settings === remoteSettings
              ? Math.max(current.settingsRev, pSettingsRev ?? 0)
              : current.settingsRev,
          tasks,
          logs,
          focusCompleted,
          countedEndsAts,
          tombstones: tombstoneList,
          activeTaskId,
          activeTaskRev,
        };
        const timer = remoteWins
          ? {
              status: pTimer.status,
              phase: pTimer.phase,
              durationMs: pTimer.durationMs,
              remainingMs:
                p.remainingMs === undefined
                  ? current.remainingMs
                  : pTimer.remainingMs === Infinity
                    ? current.remainingMs
                    : pTimer.remainingMs,
              // `??` would turn the remote's explicit null deadline into a
              // stale local one — only fall back when the key is absent.
              endsAt: p.endsAt === undefined ? current.endsAt : pTimer.endsAt,
              // justFinished is local-only: a peer's EQUAL-rev idle snapshot
              // must not cut the celebration short, but anything strictly
              // newer (a deliberate reset, or a live timer) supersedes it.
              justFinished:
                pStatus === "idle" && pTimerRev === current.timerRev
                  ? current.justFinished
                  : false,
              timerRev: Math.max(current.timerRev, pTimerRev ?? 0),
            }
          : {};
        const out = { ...current, ...merged, ...timer };
        // Canonical idle: no deadline and remaining=duration. A live
        // just-finished slice serializes as rem:0 — normalizing HERE (not
        // in the post-hook with a rev bump) means every tab's merge emits
        // identical bytes, so the rem:0↔full forms can't write-ping-pong,
        // and housekeeping never claims a rev that would preempt a peer's
        // equal-rev live timer.
        if (out.status === "idle") {
          out.remainingMs = out.durationMs;
          out.endsAt = null;
        }
        return out;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Normalize a stale idle-with-zero snapshot — but a just-finished
        // celebration IS idle+rem0 legitimately; clearing it would cancel
        // the pending auto-break. No rev bump: housekeeping must not claim
        // a newer rev, or this write would preempt a peer's equal-rev live
        // timer. The banked data propagates through the additive merges;
        // the peer's running slice wins the equal-rev rank and lives on.
        if (state.status === "idle" && state.remainingMs <= 0 && !state.justFinished) {
          usePomodoro.setState(idleFocusPatch(state.settings));
          return;
        }
        const endsAt = state.endsAt;
        const expired =
          state.status === "running" && endsAt != null && Date.now() >= endsAt;
        if (expired && Date.now() - endsAt > 60_000) {
          // The timer finished in a previous session — count it quietly under
          // the day it actually ended, with no chime/notification/auto-break.
          // Same reasoning as above: no rev bump on a bookkeeping write.
          const patch: Partial<PomodoroState> = idleFocusPatch(state.settings);
          if (
            state.phase === "focus" &&
            !wasCounted(state.countedEndsAts, endsAt)
          ) {
            const key = todayKey(new Date(endsAt));
            patch.logs = pruneLogs({ ...state.logs, [key]: (state.logs[key] ?? 0) + 1 });
            patch.focusCompleted = state.focusCompleted + 1;
            patch.tasks = state.activeTaskId
              ? state.tasks.map((t) =>
                  t.id === state.activeTaskId ? { ...t, tomatoes: t.tomatoes + 1 } : t,
                )
              : state.tasks;
            patch.countedEndsAts = sortCounted([
              ...state.countedEndsAts,
              { at: endsAt, day: key, taskId: state.activeTaskId ?? null },
            ]);
          }
          usePomodoro.setState(patch);
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
