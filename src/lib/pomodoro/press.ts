import type { MouseEvent, TouchEvent } from "react";

let lockedUntil = 0;

function run(handler: () => void) {
  const now = Date.now();
  if (now < lockedUntil) return;
  lockedUntil = now + 280;
  handler();
}

/**
 * iOS Safari (preview iframe) often never fires click, and :active scale
 * cancels the tap. Use touchend + click with a global lock so a re-render
 * between touchend and the ghost click cannot toggle twice.
 */
export function press(handler: () => void) {
  return {
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      if ((e.currentTarget as HTMLButtonElement).disabled) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select")) return;
      e.preventDefault();
      run(handler);
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if ((e.currentTarget as HTMLButtonElement).disabled) return;
      e.preventDefault();
      run(handler);
    },
  };
}
