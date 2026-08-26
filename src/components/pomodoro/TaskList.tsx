import { memo, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { press } from "@/lib/pomodoro/press";
import { usePomodoro } from "@/lib/pomodoro/store";

export const TaskList = memo(function TaskList() {
  const tasks = usePomodoro((s) => s.tasks);
  const activeTaskId = usePomodoro((s) => s.activeTaskId);
  const addTask = usePomodoro((s) => s.addTask);
  const updateTask = usePomodoro((s) => s.updateTask);
  const removeTask = usePomodoro((s) => s.removeTask);
  const setActiveTask = usePomodoro((s) => s.setActiveTask);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nudge, setNudge] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastCommitAt = useRef(0);

  function commitNewTask(): boolean {
    const el = inputRef.current;
    const value = (el?.value ?? "").trim();
    if (!value) {
      setNudge(true);
      return false;
    }
    if (Date.now() - lastCommitAt.current < 400) return true;
    lastCommitAt.current = Date.now();
    addTask(value);
    if (el) el.value = "";
    return true;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mb-2 flex shrink-0 items-baseline justify-between px-0.5">
        <h2 className="text-xs font-medium tracking-wide text-ink-soft dark:text-mint">任务</h2>
        <span className="text-xs text-ink-soft/80 dark:text-cream/50">
          {tasks.filter((t) => !t.done).length} 件进行中
        </span>
      </div>
      <ul className="hide-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {tasks.length === 0 && (
          <li className="rounded-md bg-foam/35 px-3 py-3 text-center text-xs text-ink-soft dark:bg-cream/5 dark:text-cream/60">
            在下面输入任务，点加号添加
          </li>
        )}
        {tasks.map((task) => {
          const editing = editingId === task.id;
          return (
            <li key={task.id}>
              <div
                className={cn(
                  "flex items-center gap-1 rounded-md bg-foam/45 py-0.5 pr-1 pl-1",
                  "shadow-[var(--shadow-border)] dark:bg-cream/8",
                  activeTaskId === task.id && "ring-2 ring-sakura/70",
                )}
              >
                <button
                  type="button"
                  aria-label={task.done ? "标为未完成" : "完成任务"}
                  {...press(() => updateTask(task.id, { done: !task.done }))}
                  className="grid size-11 shrink-0 place-items-center rounded-sm active:opacity-80"
                >
                  <span
                    className={cn(
                      "grid size-5 place-items-center rounded-sm border",
                      task.done
                        ? "border-mint-deep bg-mint text-ink"
                        : "border-ink/25 bg-foam/80 dark:border-cream/30 dark:bg-transparent",
                    )}
                  >
                    {task.done && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                </button>
                {editing ? (
                  <div className="min-w-0 flex-1 py-2">
                    <TaskTitle
                      value={task.title}
                      done={task.done}
                      editing
                      onEditEnd={() => setEditingId(null)}
                      onChange={(title) => updateTask(task.id, { title })}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    {...press(() => {
                      if (activeTaskId === task.id) setEditingId(task.id);
                      else setActiveTask(task.id);
                    })}
                    className="min-w-0 flex-1 py-2 text-left"
                  >
                    <TaskTitle
                      value={task.title}
                      done={task.done}
                      editing={false}
                      onEditEnd={() => setEditingId(null)}
                      onChange={(title) => updateTask(task.id, { title })}
                    />
                  </button>
                )}
                <span className="shrink-0 rounded-full bg-sakura/80 px-2 py-0.5 text-xs font-medium tabular-nums text-ink">
                  ×{task.tomatoes}
                </span>
                <button
                  type="button"
                  aria-label="删除任务"
                  {...press(() => removeTask(task.id))}
                  className="grid size-11 shrink-0 place-items-center rounded-sm text-ink-soft active:opacity-80 dark:text-cream/60"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <form
        className="mt-2 flex shrink-0 items-center gap-1.5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!commitNewTask()) inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          name="sakura-new-task"
          placeholder="新任务，例如：读完一章"
          maxLength={80}
          inputMode="text"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          onAnimationEnd={() => setNudge(false)}
          className={cn(
            "composer-input h-12 min-w-0 flex-1 rounded-md bg-foam/80 px-3 text-ink shadow-[var(--shadow-border)] outline-none",
            "placeholder:text-ink-soft/70 focus:ring-2 focus:ring-sakura",
            "dark:bg-cream/10 dark:text-cream dark:placeholder:text-cream/40",
            nudge && "task-input-nudge",
          )}
        />
        <button
          type="submit"
          aria-label="添加任务"
          {...press(() => {
            commitNewTask();
          })}
          className="grid size-12 shrink-0 place-items-center rounded-lg bg-sakura text-ink shadow-[var(--shadow-border)] active:opacity-80"
        >
          <Plus className="pointer-events-none size-5" />
        </button>
      </form>
    </section>
  );
});

function TaskTitle({
  value,
  done,
  editing,
  onEditEnd,
  onChange,
}: {
  value: string;
  done: boolean;
  editing: boolean;
  onEditEnd: () => void;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const composing = useRef(false);
  useEffect(() => {
    if (!composing.current) setText(value);
  }, [value]);

  function commit() {
    const next = text.trim() || value;
    setText(next);
    onChange(next);
    onEditEnd();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      setText(value);
      onEditEnd();
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          setText(e.currentTarget.value);
        }}
        onBlur={commit}
        onKeyDown={onKey}
        maxLength={80}
        inputMode="text"
        enterKeyHint="done"
        autoComplete="off"
        className="composer-input h-8 w-full rounded-sm bg-foam/90 px-1.5 text-ink outline-none ring-2 ring-mint dark:bg-night-card dark:text-cream"
      />
    );
  }

  return (
    <span
      className={cn(
        "block truncate text-sm font-medium text-ink dark:text-cream",
        done && "text-ink-soft line-through dark:text-cream/45",
      )}
    >
      {value}
    </span>
  );
}
