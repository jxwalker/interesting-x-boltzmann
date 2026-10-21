import { HIST_VMAX, V0, maxwellPdf, type Gas } from "./sim";

export const BG = "#050a12";
/** Speed that maps to the white-hot end of the palette. */
const COLOR_VMAX = 2.6 * V0;
const BUCKETS = 40;

type RGB = readonly [number, number, number];

const STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, [22, 36, 128]],
  [0.2, [34, 104, 232]],
  [0.38, [56, 226, 255]],
  [0.58, [255, 146, 52]],
  [0.8, [255, 210, 150]],
  [1, [255, 255, 255]],
];

/** Deep blue → cyan → orange → white hot, t in [0, 1]. */
export function heatRGB(t: number): RGB {
  const u = Math.min(1, Math.max(0, t));
  for (let k = 1; k < STOPS.length; k++) {
    const [t1, c1] = STOPS[k]!;
    if (u <= t1) {
      const [t0, c0] = STOPS[k - 1]!;
      const f = (u - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return STOPS[STOPS.length - 1]![1];
}

export function speedRGB(s: number): RGB {
  return heatRGB(s / COLOR_VMAX);
}

const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** CSS gradient matching the particle palette (for the on-stage key). */
export function paletteCss(): string {
  return `linear-gradient(90deg, ${STOPS.map(([t, c]) => `${rgba(c, 1)} ${t * 100}%`).join(", ")})`;
}

/** Size the backing store for DPR; returns true if it changed (which clears the canvas). */
export function fitCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): boolean {
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width === bw && canvas.height === bh) return false;
  canvas.width = bw;
  canvas.height = bh;
  return true;
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return ctx;
}

// ---------------------------------------------------------------------------
// Gas stage

interface Sprites {
  key: string;
  images: HTMLCanvasElement[];
  /** CSS px edge length each sprite is drawn at. */
  size: number;
}

let sprites: Sprites | null = null;

/** One pre-rendered glow disk per speed bucket; drawImage is far cheaper than per-disk gradients. */
function getSprites(coreR: number, dpr: number): Sprites {
  const key = `${coreR.toFixed(2)}@${dpr}`;
  if (sprites?.key === key) return sprites;
  const glowR = coreR * 3.2;
  const size = glowR * 2;
  const px = Math.max(4, Math.ceil(size * dpr));
  const images: HTMLCanvasElement[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const c = heatRGB((b + 0.5) / BUCKETS);
    const cv = document.createElement("canvas");
    cv.width = px;
    cv.height = px;
    const g = ctx2d(cv);
    const m = px / 2;
    const core = coreR / glowR;
    const grad = g.createRadialGradient(m, m, 0, m, m, m);
    const hot: RGB = [
      Math.min(255, c[0] + 70),
      Math.min(255, c[1] + 70),
      Math.min(255, c[2] + 70),
    ];
    grad.addColorStop(0, rgba(hot, 1));
    grad.addColorStop(core * 0.55, rgba(c, 1));
    grad.addColorStop(core, rgba(c, 0.85));
    grad.addColorStop(core * 1.35, rgba(c, 0.22));
    grad.addColorStop(0.6, rgba(c, 0.07));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, px, px);
    images.push(cv);
  }
  sprites = { key, images, size };
  return sprites;
}

export interface Ripple {
  x: number;
  y: number;
  age: number;
}

export interface StageFx {
  ripples: readonly Ripple[];
  /** Barrier x in sim units, or null. */
  wallX: number | null;
  /** 0 = wall down, 1 = fully lifted. */
  wallLift: number;
  /** Seconds until the wall lifts (for the pulse). */
  wallPulse: number;
  clear: boolean;
}

export function drawStage(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number,
  gas: Gas,
  fx: StageFx,
): void {
  const ctx = ctx2d(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  // Translucent wipe = short motion trails.
  ctx.globalAlpha = fx.clear ? 1 : 0.34;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalAlpha = 1;

  const k = cssH / gas.h;
  const coreR = Math.max(1.8, gas.r * k * 1.3);
  const sp = getSprites(coreR, dpr);
  const half = sp.size / 2;
  const bucketScale = BUCKETS / COLOR_VMAX;
  const { x, y, vx, vy, n } = gas;

  ctx.globalCompositeOperation = "source-over";
  for (let i = 0; i < n; i++) {
    const s = Math.sqrt(vx[i]! * vx[i]! + vy[i]! * vy[i]!);
    const b = Math.min(BUCKETS - 1, (s * bucketScale) | 0);
    ctx.drawImage(sp.images[b]!, x[i]! * k - half, cssH - y[i]! * k - half, sp.size, sp.size);
  }

  for (const r of fx.ripples) {
    const f = r.age / RIPPLE_LIFE;
    const rad = (2 + 26 * Math.sqrt(f)) * k;
    ctx.strokeStyle = `rgba(255, 196, 120, ${0.55 * (1 - f)})`;
    ctx.lineWidth = 2.5 * (1 - f) + 0.5;
    ctx.beginPath();
    ctx.arc(r.x * k, cssH - r.y * k, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";

  if (fx.wallX !== null && fx.wallLift < 1) {
    const wx = fx.wallX * k;
    const bottom = cssH * (1 - fx.wallLift);
    const pulse = 0.75 + 0.25 * Math.sin(fx.wallPulse * 14);
    ctx.fillStyle = `rgba(126, 232, 255, ${0.12 * pulse})`;
    ctx.fillRect(wx - 5, 0, 10, bottom);
    ctx.fillStyle = `rgba(214, 246, 255, ${0.85 * pulse})`;
    ctx.fillRect(wx - 1, 0, 2, bottom);
  }
}

export const RIPPLE_LIFE = 0.8;

// ---------------------------------------------------------------------------
// Speed histogram

const HP = { l: 6, r: 6, t: 8, b: 18 };

export function drawHistogram(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number,
  bins: Float32Array,
  v2: number,
  yMax: number,
): void {
  const ctx = ctx2d(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pw = cssW - HP.l - HP.r;
  const ph = cssH - HP.t - HP.b;
  const base = HP.t + ph;
  const nb = bins.length;
  const bw = pw / nb;
  const binV = HIST_VMAX / nb;

  for (let k = 0; k < nb; k++) {
    const v = bins[k]!;
    if (v <= 0) continue;
    const over = v > yMax;
    const hgt = Math.max(1, (Math.min(v, yMax) / yMax) * ph);
    const c = speedRGB((k + 0.5) * binV);
    const x0 = HP.l + k * bw + 0.5;
    const grad = ctx.createLinearGradient(0, base - hgt, 0, base);
    grad.addColorStop(0, rgba(c, 0.95));
    grad.addColorStop(1, rgba(c, 0.25));
    ctx.fillStyle = grad;
    ctx.fillRect(x0, base - hgt, Math.max(1, bw - 1), hgt);
    if (over) {
      // Off-scale spike: bright cap with a chevron.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x0, HP.t, Math.max(1, bw - 1), 2);
      const cx = x0 + (bw - 1) / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 4, HP.t + 8);
      ctx.lineTo(cx, HP.t + 4);
      ctx.lineTo(cx + 4, HP.t + 8);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Maxwell–Boltzmann curve for the current energy.
  const steps = 140;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * HIST_VMAX;
    const px = HP.l + (i / steps) * pw;
    const py = base - Math.min(1.02, maxwellPdf(s, v2) / yMax) * ph;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255, 240, 200, 0.28)";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = "#fff3d6";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(140, 190, 215, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(HP.l, base + 0.5);
  ctx.lineTo(cssW - HP.r, base + 0.5);
  ctx.stroke();

  ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillStyle = "rgba(138, 163, 184, 0.9)";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText("0", HP.l, cssH - 4);
  ctx.textAlign = "right";
  ctx.fillText("speed →", cssW - HP.r, cssH - 4);
}

// ---------------------------------------------------------------------------
// Entropy time series

export const ENTROPY_WINDOW = 20;
const EP = { l: 6, r: 6, t: 18, b: 16 };
const Y_TOP = 0.2;

export function drawEntropy(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number,
  ts: readonly number[],
  vals: readonly number[],
  now: number,
  yMin: number,
): void {
  const ctx = ctx2d(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pw = cssW - EP.l - EP.r;
  const ph = cssH - EP.t - EP.b;
  const mx = (t: number) => EP.l + (1 - (now - t) / ENTROPY_WINDOW) * pw;
  const my = (v: number) => EP.t + ((Y_TOP - Math.max(yMin, Math.min(Y_TOP, v))) / (Y_TOP - yMin)) * ph;
  const y0 = my(0);

  ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillStyle = "rgba(94, 234, 212, 0.75)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("equilibrium (max S)", EP.l, EP.t - 6);

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(94, 234, 212, 0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(EP.l, y0 + 0.5);
  ctx.lineTo(cssW - EP.r, y0 + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  if (vals.length > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(EP.l, EP.t - 2, pw, ph + 2);
    ctx.clip();
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const px = mx(ts[i]!);
      const py = my(vals[i]!);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    const lastX = mx(ts[ts.length - 1]!);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#5eead4";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(lastX, EP.t + ph);
    ctx.lineTo(mx(ts[0]!), EP.t + ph);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, EP.t, 0, EP.t + ph);
    grad.addColorStop(0, "rgba(94, 234, 212, 0.22)");
    grad.addColorStop(1, "rgba(94, 234, 212, 0)");
    ctx.fillStyle = grad;
    ctx.fill();
    const lv = vals[vals.length - 1]!;
    ctx.fillStyle = "#d9fff7";
    ctx.beginPath();
    ctx.arc(lastX, my(lv), 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = "rgba(138, 163, 184, 0.9)";
  ctx.textAlign = "left";
  ctx.fillText(`−${ENTROPY_WINDOW} s`, EP.l, cssH - 3);
  ctx.textAlign = "right";
  ctx.fillText("now", cssW - EP.r, cssH - 3);
}
