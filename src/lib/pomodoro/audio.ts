/** Tiny Web Audio chimes — no external files. */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  c: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain = 0.07,
  type: OscillatorType = "sine",
) {
  const osc = c.createOscillator();
  const g = c.createGain();
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2400;
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.025);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export function playStartChime(muted: boolean) {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // soft pentatonic lift
  tone(c, 523.25, t, 0.45, 0.05);
  tone(c, 659.25, t + 0.09, 0.5, 0.06);
  tone(c, 783.99, t + 0.18, 0.7, 0.055);
}

export function playEndChime(muted: boolean) {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  tone(c, 659.25, t, 0.4, 0.06);
  tone(c, 830.61, t + 0.12, 0.5, 0.07);
  tone(c, 987.77, t + 0.24, 0.85, 0.065);
  tone(c, 1318.5, t + 0.36, 1.0, 0.04);
}

/** Resume an existing context. Does not create one (that needs a user gesture). */
export function resumeAudio() {
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
}
