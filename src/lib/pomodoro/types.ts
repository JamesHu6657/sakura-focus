export type Phase = "focus" | "shortBreak" | "longBreak";
export type TimerStatus = "idle" | "running" | "paused";
export type CharState = "idle" | "focus" | "rest" | "done";
export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  longBreakEvery: number;
  muted: boolean;
  notify: boolean;
  theme: ThemePref;
  wakeLock: boolean;
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
  tomatoes: number;
  createdAt: number;
  updatedAt: number;
}

/** A counted focus completion: the deadline that was counted, the local
 *  day-key it was logged under, and the task credited. `day`/`taskId` are
 *  stored (not recomputed) so merge floors stay correct across timezone
 *  changes and let per-task tomatoes heal the max-join undercount. */
export interface CountedEnd {
  at: number;
  day: string;
  taskId?: string | null;
}

/** A deleted task. `at` lets the merge cap evict by recency instead of by
 *  random-id sort order (which could evict yesterday's delete first). */
export interface Tombstone {
  id: string;
  at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  muted: false,
  notify: true,
  theme: "system",
  wakeLock: true,
};

export const STORAGE_KEY = "sakura-focus-v1";
export const MAX_TASKS = 50;
