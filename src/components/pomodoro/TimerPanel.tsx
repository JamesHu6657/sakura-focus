import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Moon, Pause, Play, RotateCcw, Settings, SkipForward, Sun, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { press } from "@/lib/pomodoro/press";
import { pickQuote, QUOTES } from "@/lib/pomodoro/quotes";
import { PHASE_LABEL, selectCharState, usePomodoro } from "@/lib/pomodoro/store";
import { QuoteBubble } from "./QuoteBubble";
import { stashOpenerFocus } from "@/lib/pomodoro/focus";
import { StatsBar } from "./StatsBar";
import { TaskList } from "./TaskList";
import { TimerRing } from "./TimerRing";

export function TimerPanel() {
  const status = usePomodoro((s) => s.status);
  const phase = usePomodoro((s) => s.phase);
  const durationMs = usePomodoro((s) => s.durationMs);
  const justFinished = usePomodoro((s) => s.justFinished);
  const settings = usePomodoro((s) => s.settings);
  const focusCompleted = usePomodoro((s) => s.focusCompleted);
  const startFocus = usePomodoro((s) => s.startFocus);
  const startBreak = usePomodoro((s) => s.startBreak);
  const pause = usePomodoro((s) => s.pause);
  const resume = usePomodoro((s) => s.resume);
  const skip = usePomodoro((s) => s.skip);
  const reset = usePomodoro((s) => s.reset);
  const patchSettings = usePomodoro((s) => s.patchSettings);
  const setSettingsOpen = usePomodoro((s) => s.setSettingsOpen);
  const charState = usePomodoro(selectCharState);

  const [quote, setQuote] = useState(() => QUOTES[charState][0] ?? pickQuote(charState));
  const prevChar = useRef<typeof charState | null>(null);
  useEffect(() => {
    if (prevChar.current === charState) return;
    const first = prevChar.current === null;
    prevChar.current = charState;
    if (first) return;
    setQuote((prev) => pickQuote(charState, prev));
  }, [charState]);

  const every = Math.max(2, settings.longBreakEvery);
  const remainder = focusCompleted % every;
  const cyclePos =
    remainder === 0 && focusCompleted > 0 && (justFinished || phase !== "focus") ? every : remainder;
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains("dark"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  function primaryAction() {
    if (justFinished) startBreak();
    else if (status === "running") pause();
    else if (status === "paused") resume();
    else startFocus();
  }

  const primaryLabel = justFinished
    ? "去休息"
    : status === "running"
      ? "暂停"
      : status === "paused"
        ? "继续"
        : "开始";

  return (
    <div className="glass flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-xl p-3">
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-[0.18em] text-ink-soft dark:text-mint">SAKURA FOCUS</p>
          <h1 className="truncate text-lg font-semibold leading-tight text-ink dark:text-cream">樱时</h1>
        </div>
        <div className="flex items-center">
          <IconBtn
            label={settings.muted ? "开启声音" : "静音"}
            onClick={() => patchSettings({ muted: !settings.muted })}
          >
            {settings.muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </IconBtn>
          <IconBtn
            label={dark ? "浅色模式" : "深色模式"}
            onClick={() => patchSettings({ theme: dark ? "light" : "dark" })}
          >
            {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </IconBtn>
          <IconBtn
            label="设置"
            onClick={() => {
              stashOpenerFocus();
              setSettingsOpen(true);
            }}
          >
            <Settings className="size-5" />
          </IconBtn>
        </div>
      </header>

      <QuoteBubble text={quote} />

      <TimerRing
        durationMs={durationMs}
        phase={phase}
        status={status}
        justFinished={justFinished}
        onPress={primaryAction}
      />

      <div className="flex items-center justify-center gap-1.5" aria-label="本轮进度">
        {Array.from({ length: every }, (_, i) => (
          <span
            key={i}
            className={cn(
              "size-2 rounded-full",
              i < cyclePos ? "bg-sakura-deep" : "bg-ink/15 dark:bg-cream/20",
            )}
          />
        ))}
        <span className="ml-1 text-xs text-ink-soft dark:text-cream/55">
          {justFinished ? "完成！" : status === "idle" ? "准备专注" : PHASE_LABEL[phase]}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        <button
          type="button"
          {...press(primaryAction)}
          className={cn(
            "col-span-2 flex h-12 items-center justify-center gap-1.5 rounded-lg bg-sakura text-sm font-semibold text-ink",
            "shadow-[0_8px_20px_color-mix(in_oklab,var(--color-sakura)_45%,transparent)]",
            "active:opacity-80",
          )}
        >
          {status === "running" ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4 translate-x-px" />
          )}
          {primaryLabel}
        </button>
        <button
          type="button"
          disabled={status === "idle" && !justFinished}
          {...press(skip)}
          className="flex h-12 items-center justify-center gap-1 rounded-lg bg-foam/55 text-xs font-medium text-ink shadow-[var(--shadow-border)] active:opacity-80 disabled:opacity-40 dark:bg-cream/10 dark:text-cream"
        >
          <SkipForward className="size-4" />
          跳过
        </button>
        <button
          type="button"
          {...press(reset)}
          className="flex h-12 items-center justify-center gap-1 rounded-lg bg-foam/55 text-xs font-medium text-ink shadow-[var(--shadow-border)] active:opacity-80 dark:bg-cream/10 dark:text-cream"
        >
          <RotateCcw className="size-4" />
          重置
        </button>
      </div>

      <TaskList />
      <StatsBar />
    </div>
  );
}

const IconBtn = memo(function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      {...press(onClick)}
      className="grid size-11 place-items-center rounded-md text-ink active:opacity-80 dark:text-cream"
    >
      {children}
    </button>
  );
});
