import type { HouseStatus } from "../../convex/status";

/**
 * „Pixel-Funken“ beim Antippen eines Hauses: kleine eckige Pixel und eine Welle.
 * Flyer drin: helle Funken springen hoch und fallen. Nicht möglich: matter Staub rieselt.
 * Wieder offen: dunkle Pixel ziehen sich zusammen. Koordinaten in CSS-Pixeln um den Tipp.
 */
export const BURST_SECONDS = 0.85;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  size: number;
  color: string;
  twinkle: number;
  star: boolean;
  /** schrumpft beim Verlöschen (wieder offen) */
  shrink: boolean;
}
export interface Burst {
  kind: HouseStatus;
  parts: Particle[];
  ring: { color: string; radius: number } | null;
  edge: string | null;
}

const KINDS = {
  done: { n: 26, speed: [110, 240], up: -140, g: 560, size: [3, 5], life: [0.5, 0.8], colors: ["#ffd60a", "#ffe866", "#fff6c2", "#ffffff", "#ffb800"], ring: { color: "#ffd60a", radius: 34 }, edge: "#7a5800" },
  blocked: { n: 14, speed: [25, 70], up: -10, g: 160, size: [3, 4], life: [0.5, 0.8], colors: ["#938443", "#b3a35a", "#6f6331", "#c9bd85"], ring: { color: "#938443", radius: 22 }, edge: "#3b3416" },
  none: { n: 16, speed: [55, 85], up: 0, g: 0, size: [3, 4], life: [0.35, 0.5], colors: ["#24262c", "#3a3e47", "#6b6f78"], ring: null, edge: null },
} as const;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

export function createBurst(kind: HouseStatus, seed = Math.random() * 1e9): Burst {
  const r = rng(seed | 0);
  const c = KINDS[kind];
  const between = ([a, b]: readonly number[]) => a + r() * (b - a);
  const parts: Particle[] = [];
  for (let i = 0; i < c.n; i++) {
    const a = r() * Math.PI * 2;
    const sp = between(c.speed);
    const life = between(c.life);
    const size = Math.round(between(c.size));
    const color = c.colors[i % c.colors.length];
    if (kind === "none") {
      const d = 26 + r() * 10;
      parts.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, vx: -Math.cos(a) * sp, vy: -Math.sin(a) * sp, g: 0, life, size, color, twinkle: 0, star: false, shrink: true });
    } else {
      parts.push({
        x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8 + c.up * (0.5 + r() * 0.5),
        g: c.g, life, size, color, twinkle: r() * 6, star: kind === "done" && i % 4 === 0 && size <= 4, shrink: false,
      });
    }
  }
  return { kind, parts, ring: c.ring, edge: c.edge };
}

/** Lage eines Funkens nach t Sekunden; null, wenn er erloschen ist. */
export function particleAt(p: Particle, t: number) {
  if (t >= p.life) return null;
  const fade = 1 - t / p.life;
  const blink = p.twinkle && Math.sin(t * 28 + p.twinkle) > 0.6 ? 1 : p.twinkle ? 0.65 : 1;
  const size = p.shrink ? Math.min(p.size, Math.max(1, Math.ceil(p.size * (fade + 0.3)))) : p.size;
  return { x: p.x + p.vx * t, y: p.y + p.vy * t + 0.5 * p.g * t * t, alpha: Math.max(0, fade * blink), size, fade };
}

/** Zeichnet den Effekt t Sekunden nach dem Tipp an (x, y). */
export function drawBurst(ctx: CanvasRenderingContext2D, b: Burst, x: number, y: number, t: number) {
  if (b.ring && t < 0.45) {
    const p = t / 0.45;
    const e = 1 - Math.pow(1 - p, 3);
    const width = 3 * (1 - p) + 1;
    ctx.beginPath();
    ctx.arc(x, y, 6 + e * b.ring.radius, 0, Math.PI * 2);
    // dunkler Rand, damit die Welle auch auf einem gelben Haus zu sehen ist
    if (b.edge) {
      ctx.strokeStyle = b.edge;
      ctx.globalAlpha = (1 - p) * 0.5;
      ctx.lineWidth = width + 2;
      ctx.stroke();
    }
    ctx.strokeStyle = b.ring.color;
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  for (const part of b.parts) {
    const at = particleAt(part, t);
    if (!at) continue;
    const s = at.size;
    const px = Math.round(x + at.x - s / 2);
    const py = Math.round(y + at.y - s / 2);
    if (b.edge) {
      // dunkler Rand, damit helle Pixel auch auf hellem Grund leuchten
      ctx.globalAlpha = at.alpha * 0.55;
      ctx.fillStyle = b.edge;
      ctx.fillRect(px - 1, py - 1, s + 2, s + 2);
    }
    ctx.globalAlpha = at.alpha;
    ctx.fillStyle = part.color;
    ctx.fillRect(px, py, s, s);
    if (part.star && at.fade > 0.3) {
      ctx.fillRect(px - s, py, s, s);
      ctx.fillRect(px + s, py, s, s);
      ctx.fillRect(px, py - s, s, s);
      ctx.fillRect(px, py + s, s, s);
    }
  }
  ctx.globalAlpha = 1;
}
