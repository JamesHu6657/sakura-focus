import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, BellOff, Monitor, Moon, Sun, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { press } from "@/lib/pomodoro/press";
import { requestNotifyPerm, usePomodoro } from "@/lib/pomodoro/store";
import type { ThemePref } from "@/lib/pomodoro/types";

export function SettingsSheet() {
  const open = usePomodoro((s) => s.settingsOpen);
  const setOpen = usePomodoro((s) => s.setSettingsOpen);
  const settings = usePomodoro((s) => s.settings);
  const patch = usePomodoro((s) => s.patchSettings);
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | "unsupported">("default");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof Notification === "undefined") setNotifyPerm("unsupported");
    else setNotifyPerm(Notification.permission);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const notifyUnsupported = notifyPerm === "unsupported";
  const notifyDenied = notifyPerm === "denied";
  const notifyOn = Boolean(settings.notify) && notifyPerm === "granted";

  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="关闭设置"
        className="absolute inset-0 bg-ink/35 dark:bg-night/60"
        {...press(() => setOpen(false))}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="glass relative z-10 max-h-[min(88dvh,640px)] w-full max-w-md overflow-y-auto rounded-xl p-5 outline-none"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="settings-title" className="text-base font-semibold text-ink dark:text-cream">
            设置
          </h2>
          <button
            type="button"
            aria-label="关闭"
            {...press(() => setOpen(false))}
            className="grid size-11 place-items-center rounded-md text-ink active:opacity-80 dark:text-cream"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-xs font-medium tracking-wide text-ink-soft dark:text-mint">
              时长（分钟）
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <Stepper
                label="专注"
                value={settings.focusMin}
                min={1}
                max={90}
                onChange={(v) => patch({ focusMin: v })}
              />
              <Stepper
                label="短休息"
                value={settings.shortBreakMin}
                min={1}
                max={30}
                onChange={(v) => patch({ shortBreakMin: v })}
              />
              <Stepper
                label="长休息"
                value={settings.longBreakMin}
                min={1}
                max={45}
                onChange={(v) => patch({ longBreakMin: v })}
              />
              <Stepper
                label="长休间隔"
                value={settings.longBreakEvery}
                min={2}
                max={8}
                onChange={(v) => patch({ longBreakEvery: v })}
              />
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-xs font-medium tracking-wide text-ink-soft dark:text-mint">
              外观
            </legend>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  ["system", "跟随系统", Monitor],
                  ["light", "浅色", Sun],
                  ["dark", "深色", Moon],
                ] as const satisfies ReadonlyArray<readonly [ThemePref, string, typeof Monitor]>
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  {...press(() => patch({ theme: value }))}
                  className={cn(
                    "flex h-11 items-center justify-center gap-1.5 rounded-md text-xs font-medium",
                    "active:opacity-80",
                    settings.theme === value
                      ? "bg-sakura text-ink"
                      : "bg-foam/50 text-ink-soft dark:bg-cream/10 dark:text-cream/80",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <ToggleRow
            label="提示音"
            on={!settings.muted}
            onClick={() => patch({ muted: !settings.muted })}
          />
          <ToggleRow
            label="结束时系统通知"
            on={notifyOn}
            disabled={notifyUnsupported || notifyDenied}
            onClick={() => {
              if (notifyOn) {
                patch({ notify: false });
                return;
              }
              void requestNotifyPerm().then(() => {
                const perm =
                  typeof Notification === "undefined" ? "unsupported" : Notification.permission;
                setNotifyPerm(perm);
                patch({ notify: perm === "granted" });
              });
            }}
            icon={notifyOn ? <Bell className="size-4" /> : <BellOff className="size-4" />}
            hint={
              notifyUnsupported
                ? "此浏览器不支持通知"
                : notifyDenied
                  ? "已在系统中关闭"
                  : notifyOn
                    ? "已开启"
                    : "点击申请权限"
            }
          />
          <ToggleRow
            label="专注时保持屏幕常亮"
            on={settings.wakeLock}
            onClick={() => patch({ wakeLock: !settings.wakeLock })}
            hint="不支持时会静默跳过"
          />
        </div>
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-foam/45 px-2 py-2 dark:bg-cream/8">
      <span className="text-xs text-ink-soft dark:text-cream/60">{label}</span>
      <span className="flex items-center justify-between">
        <button
          type="button"
          aria-label={`减少${label}`}
          className="grid size-11 place-items-center rounded-sm text-lg text-ink active:opacity-80 dark:text-cream"
          {...press(() => onChange(Math.max(min, value - 1)))}
        >
          −
        </button>
        <span className="min-w-8 text-center text-base font-semibold tabular-nums text-ink dark:text-cream">
          {value}
        </span>
        <button
          type="button"
          aria-label={`增加${label}`}
          className="grid size-11 place-items-center rounded-sm text-lg text-ink active:opacity-80 dark:text-cream"
          {...press(() => onChange(Math.min(max, value + 1)))}
        >
          +
        </button>
      </span>
    </div>
  );
}

function ToggleRow({
  label,
  on,
  onClick,
  hint,
  icon,
  disabled,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      {...press(onClick)}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md bg-foam/45 px-3 py-2 text-left active:opacity-80 disabled:opacity-50 dark:bg-cream/8"
    >
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink dark:text-cream">
          {icon}
          {label}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-ink-soft dark:text-cream/50">{hint}</span>}
      </span>
      <span
        className={cn(
          "relative h-6 w-10 shrink-0 rounded-full",
          on ? "bg-mint-deep" : "bg-ink/20 dark:bg-cream/20",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-foam shadow-sm",
            "transition-transform duration-150 ease-out",
            on ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}
