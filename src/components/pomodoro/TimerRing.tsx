import { formatMmSs } from "@/lib/utils";
import { press } from "@/lib/pomodoro/press";
import { PHASE_LABEL } from "@/lib/pomodoro/store";
import { useRemainingMs } from "@/lib/pomodoro/useRemaining";
import type { Phase, TimerStatus } from "@/lib/pomodoro/types";

function mix(a: number[], b: number[], t: number) {
  const u = Math.min(1, Math.max(0, t));
  return a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * u));
}

const PINK = [255, 183, 197];
const PLUM = [155, 110, 196];

export function TimerRing({
  durationMs,
  phase,
  status,
  justFinished,
  onPress,
}: {
  durationMs: number;
  phase: Phase;
  status: TimerStatus;
  justFinished: boolean;
  onPress: () => void;
  pressLabel?: string;
}) {
  const remainingMs = useRemainingMs();
  const ratio = durationMs <= 0 ? 0 : Math.min(1, Math.max(0, remainingMs / durationMs));
  const progress = 1 - ratio;
  const [r, g, b] = mix(PINK, PLUM, justFinished ? 1 : progress);
  const stroke = `rgb(${r} ${g} ${b})`;
  const radius = 88;
  const c = 2 * Math.PI * radius;
  const offset = c * (1 - ratio);
  const label = justFinished
    ? "完成啦"
    : status === "paused"
      ? "已暂停"
      : status === "idle"
        ? "准备开始"
        : PHASE_LABEL[phase];

  return (
    <button
      type="button"
      aria-label="计时圆环"
      {...press(onPress)}
      className="timer-ring relative mx-auto aspect-square active:opacity-80"
    >
      <svg viewBox="0 0 200 200" className="pointer-events-none h-full w-full -rotate-90" aria-hidden="true">
        <circle
          cx="100"
          cy="100"
          r={radius}
          fill="none"
          className="stroke-sakura/30 dark:stroke-cream/15"
          strokeWidth="10"
        />
        <circle
          cx="100"
          cy="100"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="drop-shadow-[0_0_10px_rgba(255,183,197,0.55)]"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-sans text-[clamp(1.75rem,7vmin,2.75rem)] font-bold leading-none tabular-nums tracking-tight text-ink dark:text-cream"
          aria-hidden="true"
        >
          {formatMmSs(remainingMs)}
        </span>
        <span className="mt-2 text-xs font-medium tracking-wide text-ink-soft dark:text-mint">
          {label}
        </span>
      </div>
    </button>
  );
}
