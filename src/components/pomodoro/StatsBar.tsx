import { memo } from "react";
import { lastNDates, todayKey } from "@/lib/utils";
import { usePomodoro } from "@/lib/pomodoro/store";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export const StatsBar = memo(function StatsBar() {
  const logs = usePomodoro((s) => s.logs);
  const days = lastNDates(7);
  const today = todayKey();
  const counts = days.map((d) => logs[d] ?? 0);
  const max = Math.max(1, ...counts);
  const todayCount = logs[today] ?? 0;
  const weekCount = counts.reduce((a, b) => a + b, 0);

  return (
    <section className="stats-bar shrink-0 rounded-lg bg-foam/40 px-3 py-2 shadow-[var(--shadow-border)] dark:bg-cream/8">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h2 className="text-xs font-medium tracking-wide text-ink-soft dark:text-mint">番茄统计</h2>
        <p className="text-xs text-ink-soft dark:text-cream/60">
          今日 <span className="font-semibold tabular-nums text-ink dark:text-cream">{todayCount}</span>
          <span className="mx-1.5 text-ink-soft/40">·</span>
          本周 <span className="font-semibold tabular-nums text-ink dark:text-cream">{weekCount}</span>
        </p>
      </div>
      <div className="flex h-9 items-end gap-1.5">
        {days.map((d, i) => {
          const n = counts[i] ?? 0;
          const h = n === 0 ? 3 : Math.max(6, Math.round((n / max) * 32));
          const date = new Date(`${d}T12:00:00`);
          const isToday = d === today;
          return (
            <div key={d} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className="w-full max-w-6 rounded-t-sm"
                style={{
                  height: h,
                  background: isToday
                    ? "var(--color-sakura-deep)"
                    : n > 0
                      ? "var(--color-sakura)"
                      : "color-mix(in oklab, var(--color-ink) 14%, transparent)",
                }}
                title={`${d} · ${n}`}
              />
              <span
                className={
                  isToday
                    ? "text-[10px] font-semibold text-sakura-deep dark:text-sakura"
                    : "text-[10px] text-ink-soft dark:text-cream/50"
                }
              >
                {WEEKDAYS[date.getDay()]}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
});
