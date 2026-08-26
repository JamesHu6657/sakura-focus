const PETALS = [
  { left: "4%", delay: "-2s", dur: "16s", size: 11, rot: 12, opacity: 0.55 },
  { left: "12%", delay: "-9s", dur: "18s", size: 14, rot: -20, opacity: 0.4 },
  { left: "21%", delay: "-4s", dur: "14s", size: 9, rot: 40, opacity: 0.5 },
  { left: "33%", delay: "-11s", dur: "20s", size: 13, rot: -8, opacity: 0.45 },
  { left: "41%", delay: "-1s", dur: "15s", size: 10, rot: 28, opacity: 0.6 },
  { left: "52%", delay: "-7s", dur: "17s", size: 12, rot: -32, opacity: 0.35 },
  { left: "61%", delay: "-13s", dur: "19s", size: 8, rot: 16, opacity: 0.5 },
  { left: "70%", delay: "-3s", dur: "14s", size: 15, rot: -14, opacity: 0.42 },
  { left: "78%", delay: "-8s", dur: "16s", size: 11, rot: 36, opacity: 0.55 },
  { left: "86%", delay: "-5s", dur: "21s", size: 9, rot: -24, opacity: 0.38 },
  { left: "93%", delay: "-10s", dur: "15s", size: 13, rot: 8, opacity: 0.48 },
  { left: "17%", delay: "-15s", dur: "22s", size: 7, rot: 50, opacity: 0.32 },
  { left: "47%", delay: "-6s", dur: "13s", size: 10, rot: -40, opacity: 0.5 },
  { left: "58%", delay: "-12s", dur: "18s", size: 8, rot: 22, opacity: 0.36 },
  { left: "74%", delay: "-16s", dur: "23s", size: 12, rot: -6, opacity: 0.44 },
  { left: "28%", delay: "-14s", dur: "17s", size: 9, rot: 14, opacity: 0.4 },
] as const;

export function Petals() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {PETALS.map((p, i) => (
        <span
          key={i}
          className="petal"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            opacity: p.opacity,
            animationDelay: p.delay,
            animationDuration: p.dur,
            ["--petal-rot" as string]: `${p.rot}deg`,
          }}
        />
      ))}
    </div>
  );
}
