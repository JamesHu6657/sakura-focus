import { useEffect, useState } from "react";
import { usePomodoro } from "./store";

/** Display remaining time without writing it into the persisted store every tick. */
export function useRemainingMs() {
  const status = usePomodoro((s) => s.status);
  const endsAt = usePomodoro((s) => s.endsAt);
  const remainingMs = usePomodoro((s) => s.remainingMs);
  const [, setBeat] = useState(0);

  useEffect(() => {
    if (status !== "running") return;
    const id = window.setInterval(() => setBeat((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [status]);

  if (status === "running" && endsAt != null) {
    return Math.max(0, endsAt - Date.now());
  }
  return remainingMs;
}
