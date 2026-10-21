/**
 * 2D hard-disk gas. Box height is fixed at 100 sim units; width follows the stage aspect.
 * Equal masses, perfectly elastic collisions, uniform spatial grid rebuilt every substep.
 */

/** RMS speed at T = 1 (shown as 300 K), in sim units / s. */
export const V0 = 12;
export const KELVIN_PER_T = 300;
export const T_MIN = 0.2;
export const T_MAX = 4;
/** Fixed speed axis for the histogram, so heating visibly widens the curve. */
export const HIST_VMAX = 3.2 * V0;
export const HIST_BINS = 44;
/** Area fraction covered by disks; sets mean free path and therefore relaxation time. */
const PACKING = 0.016;
const BOX_H = 100;
const MAX_SUBSTEPS = 16;
const ENTROPY_BINS = 36;
/** Hot|Cold split: left half at T·HOT, right at T·COLD (mean stays T). */
const HOT = 1.75;
const COLD = 0.25;
const BURST_RADIUS = 12;

export type Preset = "same" | "halves";

export class Gas {
  readonly n: number;
  w: number;
  readonly h = BOX_H;
  r = 0.5;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Vertical barrier at this x (Hot|Cold preset), or null. */
  wallX: number | null = null;
  /** Cumulative collision count. */
  collisions = 0;

  private cell = 1;
  private cols = 1;
  private rows = 1;
  private cellStart = new Int32Array(2);
  private cellFill = new Int32Array(1);
  private order: Int32Array;
  private cellOf: Int32Array;
  private readonly entropyCounts = new Float64Array(ENTROPY_BINS);

  constructor(n: number, aspect: number) {
    this.n = n;
    this.w = BOX_H * aspect;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.order = new Int32Array(n);
    this.cellOf = new Int32Array(n);
    this.layout();
  }

  /** Change the box aspect, stretching positions so nobody ends up outside. */
  setAspect(aspect: number): void {
    const w = BOX_H * aspect;
    if (Math.abs(w - this.w) < 1e-3) return;
    const k = w / this.w;
    for (let i = 0; i < this.n; i++) this.x[i] *= k;
    if (this.wallX !== null) this.wallX *= k;
    this.w = w;
    this.layout();
  }

  private layout(): void {
    this.r = Math.sqrt((PACKING * this.w * this.h) / (this.n * Math.PI));
    this.cell = Math.max(2 * this.r, 2);
    this.cols = Math.max(1, Math.ceil(this.w / this.cell));
    this.rows = Math.max(1, Math.ceil(this.h / this.cell));
    const cells = this.cols * this.rows;
    if (this.cellStart.length !== cells + 1) {
      this.cellStart = new Int32Array(cells + 1);
      this.cellFill = new Int32Array(cells);
    }
  }

  reset(preset: Preset, t: number): void {
    this.collisions = 0;
    if (preset === "same") {
      this.wallX = null;
      this.scatter(0, this.n, 0, this.w, V0 * Math.sqrt(t));
    } else {
      const half = this.n >> 1;
      this.wallX = this.w / 2;
      this.scatter(0, half, 0, this.w / 2, V0 * Math.sqrt(t * HOT));
      this.scatter(half, this.n, this.w / 2, this.w, V0 * Math.sqrt(t * COLD));
    }
  }

  /** Jittered lattice in [x0, x1] × box height, every particle at exactly `speed`. */
  private scatter(from: number, to: number, x0: number, x1: number, speed: number): void {
    const count = to - from;
    const bw = x1 - x0 - 2 * this.r;
    const bh = this.h - 2 * this.r;
    const cols = Math.max(1, Math.round(Math.sqrt((count * bw) / bh)));
    const rows = Math.ceil(count / cols);
    const sx = bw / cols;
    const sy = bh / rows;
    const jx = Math.max(0, sx / 2 - this.r);
    const jy = Math.max(0, sy / 2 - this.r);
    // Shuffle slots so the empty ones on the last row aren't all in a corner.
    const slots = Array.from({ length: cols * rows }, (_, k) => k);
    for (let k = slots.length - 1; k > 0; k--) {
      const m = Math.floor(Math.random() * (k + 1));
      [slots[k], slots[m]] = [slots[m]!, slots[k]!];
    }
    for (let k = 0; k < count; k++) {
      const i = from + k;
      const s = slots[k]!;
      const c = s % cols;
      const rr = (s / cols) | 0;
      this.x[i] = x0 + this.r + (c + 0.5) * sx + (Math.random() * 2 - 1) * jx;
      this.y[i] = this.r + (rr + 0.5) * sy + (Math.random() * 2 - 1) * jy;
      const a = Math.random() * Math.PI * 2;
      this.vx[i] = Math.cos(a) * speed;
      this.vy[i] = Math.sin(a) * speed;
    }
  }

  meanV2(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.vx[i]! * this.vx[i]! + this.vy[i]! * this.vy[i]!;
    return s / this.n;
  }

  temperature(): number {
    return this.meanV2() / (V0 * V0);
  }

  scaleVelocities(k: number): void {
    for (let i = 0; i < this.n; i++) {
      this.vx[i] *= k;
      this.vy[i] *= k;
    }
  }

  /** Kick everything within BURST_RADIUS radially outward; returns particles hit. */
  burst(cx: number, cy: number, strength: number): number {
    const kick = strength * 3.2 * V0;
    let hit = 0;
    for (let i = 0; i < this.n; i++) {
      let dx = this.x[i]! - cx;
      let dy = this.y[i]! - cy;
      const d = Math.hypot(dx, dy);
      if (d >= BURST_RADIUS) continue;
      if (d < 1e-3) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a);
        dy = Math.sin(a);
      } else {
        dx /= d;
        dy /= d;
      }
      const f = kick * (1 - (d / BURST_RADIUS) * 0.6);
      this.vx[i] += dx * f;
      this.vy[i] += dy * f;
      hit++;
    }
    return hit;
  }

  step(dt: number): void {
    const { n, vx, vy } = this;
    const maxMove = 0.45 * this.r;
    const vcap = (MAX_SUBSTEPS * maxMove) / dt;
    let vmax2 = 0;
    for (let i = 0; i < n; i++) {
      const v2 = vx[i]! * vx[i]! + vy[i]! * vy[i]!;
      if (v2 > vcap * vcap) {
        const k = vcap / Math.sqrt(v2);
        vx[i] *= k;
        vy[i] *= k;
      } else if (v2 > vmax2) vmax2 = v2;
    }
    const sub = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil((Math.sqrt(vmax2) * dt) / maxMove)));
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      this.move(h);
      this.collide();
    }
  }

  private move(h: number): void {
    const { n, x, y, vx, vy, r, w } = this;
    const top = this.h - r;
    const right = w - r;
    const wall = this.wallX;
    for (let i = 0; i < n; i++) {
      const ox = x[i]!;
      let px = ox + vx[i]! * h;
      let py = y[i]! + vy[i]! * h;
      if (px < r) {
        px = r;
        vx[i] = Math.abs(vx[i]!);
      } else if (px > right) {
        px = right;
        vx[i] = -Math.abs(vx[i]!);
      }
      if (py < r) {
        py = r;
        vy[i] = Math.abs(vy[i]!);
      } else if (py > top) {
        py = top;
        vy[i] = -Math.abs(vy[i]!);
      }
      if (wall !== null) {
        if (ox < wall && px > wall - r) {
          px = wall - r;
          vx[i] = -Math.abs(vx[i]!);
        } else if (ox >= wall && px < wall + r) {
          px = wall + r;
          vx[i] = Math.abs(vx[i]!);
        }
      }
      x[i] = px;
      y[i] = py;
    }
  }

  private collide(): void {
    const { n, x, y, vx, vy, cols, rows, cell, cellStart, cellFill, order, cellOf } = this;
    const d = 2 * this.r;
    const d2 = d * d;
    const inv = 1 / cell;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, (x[i]! * inv) | 0);
      const cy = Math.min(rows - 1, (y[i]! * inv) | 0);
      const c = cy * cols + cx;
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cols * rows; c++) {
      cellStart[c + 1] += cellStart[c]!;
      cellFill[c] = cellStart[c]!;
    }
    for (let i = 0; i < n; i++) order[cellFill[cellOf[i]!]!++] = i;

    let hits = 0;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]!;
      const cx = c % cols;
      const cy = (c / cols) | 0;
      const y0 = cy > 0 ? cy - 1 : 0;
      const y1 = cy < rows - 1 ? cy + 1 : cy;
      const x0 = cx > 0 ? cx - 1 : 0;
      const x1 = cx < cols - 1 ? cx + 1 : cx;
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const g = gy * cols + gx;
          for (let k = cellStart[g]!, end = cellStart[g + 1]!; k < end; k++) {
            const j = order[k]!;
            if (j <= i) continue;
            const dx = x[j]! - x[i]!;
            const dy = y[j]! - y[i]!;
            const dist2 = dx * dx + dy * dy;
            if (dist2 >= d2 || dist2 < 1e-12) continue;
            const dist = Math.sqrt(dist2);
            const nx = dx / dist;
            const ny = dy / dist;
            const push = (d - dist) * 0.5;
            x[i] -= nx * push;
            y[i] -= ny * push;
            x[j] += nx * push;
            y[j] += ny * push;
            const vn = (vx[j]! - vx[i]!) * nx + (vy[j]! - vy[i]!) * ny;
            if (vn < 0) {
              vx[i] += vn * nx;
              vy[i] += vn * ny;
              vx[j] -= vn * nx;
              vy[j] -= vn * ny;
              hits++;
            }
          }
        }
      }
    }
    this.collisions += hits;
  }

  /** Speed pdf (fraction per unit speed) on the fixed histogram axis. */
  speedHistogram(out: Float32Array): void {
    const bins = out.length;
    const binW = HIST_VMAX / bins;
    out.fill(0);
    for (let i = 0; i < this.n; i++) {
      const s = Math.hypot(this.vx[i]!, this.vy[i]!);
      const k = Math.floor(s / binW);
      if (k < bins) out[k]++;
    }
    const norm = 1 / (this.n * binW);
    for (let k = 0; k < bins; k++) out[k] *= norm;
  }

  /**
   * S − S_eq in nats: entropy of the 2D velocity distribution (isotropic, estimated from
   * speeds with the 2πs Jacobian) minus that of a Maxwellian with the same energy.
   * 0 at equilibrium, negative when ordered.
   */
  entropyGap(): number {
    const v2 = this.meanV2();
    if (v2 <= 0) return 0;
    const counts = this.entropyCounts;
    const binW = (4 * Math.sqrt(v2)) / ENTROPY_BINS;
    counts.fill(0);
    for (let i = 0; i < this.n; i++) {
      const k = Math.floor(Math.hypot(this.vx[i]!, this.vy[i]!) / binW);
      counts[Math.min(ENTROPY_BINS - 1, k)]++;
    }
    let s = 0;
    let used = 0;
    for (let k = 0; k < ENTROPY_BINS; k++) {
      const c = counts[k]!;
      if (c === 0) continue;
      used++;
      const p = c / this.n;
      s -= p * Math.log(p / (binW * 2 * Math.PI * (k + 0.5) * binW));
    }
    s += (used - 1) / (2 * this.n); // Miller–Madow bias correction
    return s - (1 + Math.log(Math.PI * v2));
  }
}

/** 2D Maxwell–Boltzmann speed pdf for mean-square speed v2. */
export function maxwellPdf(s: number, v2: number): number {
  return ((2 * s) / v2) * Math.exp((-s * s) / v2);
}

export function maxwellPeak(v2: number): number {
  return Math.sqrt(2 / v2) * Math.exp(-0.5);
}
