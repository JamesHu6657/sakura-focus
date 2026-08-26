import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import type { CharState } from "@/lib/pomodoro/types";

const SRC: Record<CharState, string> = {
  idle: "/assets/char-idle.png",
  focus: "/assets/char-focus.png",
  rest: "/assets/char-rest.png",
  done: "/assets/char-done.png",
};

const LABEL: Record<CharState, string> = {
  idle: "待机",
  focus: "专注",
  rest: "休息",
  done: "完成",
};

const STATES: CharState[] = ["idle", "focus", "rest", "done"];

export const CharacterStage = memo(function CharacterStage({ state }: { state: CharState }) {
  const [missing, setMissing] = useState<Partial<Record<CharState, boolean>>>({});

  return (
    <div className="pointer-events-none relative flex h-full min-h-0 w-full items-end justify-center">
      <div className="char-glow" />
      <div className="relative h-full w-full max-w-full" aria-hidden="true">
        {STATES.map((s) => {
          const active = s === state;
          if (missing[s] && active) {
            return (
              <div
                key={s}
                className="absolute inset-x-[12%] bottom-[6%] top-[10%] flex items-center justify-center rounded-[28px] bg-sakura/30 text-ink/70"
              >
                <p className="px-4 text-center text-sm font-medium">立绘未找到 · {LABEL[s]}</p>
              </div>
            );
          }
          return (
            <div
              key={s}
              className={cn(
                "absolute inset-0",
                "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                "motion-reduce:translate-y-0 motion-reduce:transition-none",
                active ? "opacity-100 translate-y-0" : "pointer-events-none translate-y-2 opacity-0",
              )}
            >
              <img
                src={SRC[s]}
                alt=""
                draggable={false}
                decoding="async"
                loading="eager"
                fetchPriority={s === "idle" ? "high" : "low"}
                onError={() => setMissing((m) => ({ ...m, [s]: true }))}
                className={cn(
                  "h-full w-full object-contain object-bottom",
                  active && s === "idle" && "char-bob",
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
