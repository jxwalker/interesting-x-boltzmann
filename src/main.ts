import "./styles.css";
import {
  Gas,
  HIST_BINS,
  KELVIN_PER_T,
  T_MAX,
  T_MIN,
  maxwellPeak,
  type Preset,
} from "./sim";
import {
  ENTROPY_WINDOW,
  RIPPLE_LIFE,
  drawEntropy,
  drawHistogram,
  drawStage,
  fitCanvas,
  paletteCss,
  type Ripple,
} from "./viz";

const CREDIT_URL = "https://x.com/SciencesKL/status/2106491586754531797";
/** Seconds the Hot|Cold barrier stays down, then how long it takes to slide away. */
const WALL_HOLD = 1.0;
const WALL_LIFT = 0.35;
/** Thermostat rate toward the slider target (1/s). */
const HEAT_RATE = 5;
const SAMPLE_DT = 0.1;
const DRAG_BURST_MS = 70;
/** Charts redraw at half rate and text readouts at ~8 Hz: cheaper paints, steadier digits. */
const CHART_EVERY = 2;
const STATS_DT = 0.12;
/** Idle auto-tour (off in record mode and after any interaction). */
const TOUR_DWELL = 11;

function mustEl<T extends HTMLElement>(root: ParentNode, selector: string, ctor: new () => T): T {
  const el = root.querySelector(selector);
  if (!(el instanceof ctor)) throw new Error(`Missing or wrong element: ${selector}`);
  return el;
}

function setText(el: HTMLElement, next: string): void {
  if (el.textContent !== next) el.textContent = next;
}

const sliderToT = (u: number): number => T_MIN * Math.pow(T_MAX / T_MIN, u / 1000);
const tToSlider = (t: number): number => (1000 * Math.log(t / T_MIN)) / Math.log(T_MAX / T_MIN);
const kelvin = (t: number): string => `${Math.round(t * KELVIN_PER_T)} K`;
const signed = (v: number): string => `${v < -0.005 ? "−" : "+"}${Math.abs(v).toFixed(2)}`;

function mount(): void {
  const root = document.getElementById("app");
  if (!(root instanceof HTMLElement)) throw new Error("Missing #app");
  const recordMode = new URLSearchParams(window.location.search).has("record");

  root.innerHTML = `
    <div class="grain" aria-hidden="true"></div>
    <div class="wash" aria-hidden="true"></div>

    <header class="hero">
      <div class="hero-row">
        <p class="brand">Interesting X</p>
        <h1 class="title">Boltzmann gas playground</h1>
      </div>
      <p class="hint" id="hint">
        <span class="hint-dot" aria-hidden="true"></span>
        <span>Every particle starts at the same speed — watch collisions turn the spike into the Maxwell–Boltzmann curve. Click or drag in the gas to inject heat.</span>
      </p>
    </header>

    <main class="layout">
      <section class="stage" id="stage" aria-label="Hard-disk gas">
        <canvas id="canvas" role="img" aria-label="Hundreds of colliding particles coloured by speed"></canvas>
        <div class="speed-key" aria-hidden="true">
          <span>slow</span><i class="key-bar" style="background:${paletteCss()}"></i><span>fast</span>
        </div>
      </section>

      <aside class="panel" aria-label="Controls and measurements">
        <div class="controls">
          <div class="field">
            <label for="heat">Heat / Cool</label>
            <input id="heat" type="range" min="0" max="1000" step="1" value="${Math.round(tToSlider(1))}" />
            <div class="range-meta">
              <span>cool</span><span id="heat-val">${kelvin(1)}</span><span>hot</span>
            </div>
          </div>
          <div class="presets" role="group" aria-label="Start from">
            <button type="button" class="btn" id="btn-same">Same speed</button>
            <button type="button" class="btn" id="btn-halves">Hot | Cold</button>
          </div>
        </div>

        <div class="stats" aria-live="off">
          <div class="stat"><span class="stat-k">Temp</span><span class="stat-v v-temp" id="stat-temp">300 K</span></div>
          <div class="stat"><span class="stat-k">Entropy</span><span class="stat-v v-ent" id="stat-entropy">−0.00</span></div>
          <div class="stat"><span class="stat-k">Coll/s</span><span class="stat-v v-coll" id="stat-coll">0</span></div>
          <div class="stat"><span class="stat-k">Particles</span><span class="stat-v" id="stat-n">0</span></div>
        </div>

        <div class="card card-hist">
          <div class="card-head">
            <span class="card-title">Speed distribution</span>
            <span class="legend"><i class="lg-bars"></i>gas<i class="lg-line"></i>Maxwell–Boltzmann</span>
          </div>
          <canvas id="hist" aria-label="Speed histogram with Maxwell–Boltzmann curve"></canvas>
        </div>

        <div class="card card-ent">
          <div class="card-head">
            <span class="card-title">Entropy S − S<sub>eq</sub> <span class="unit">(nats)</span></span>
          </div>
          <canvas id="entropy" aria-label="Entropy over time"></canvas>
        </div>

        <p class="credit${recordMode ? " record-hide" : ""}">
          2D hard disks, elastic collisions. Inspired by
          <a href="${CREDIT_URL}" target="_blank" rel="noreferrer">@SciencesKL</a>.
        </p>
      </aside>
    </main>
  `;

  const stage = mustEl(root, "#stage", HTMLElement);
  const canvas = mustEl(root, "#canvas", HTMLCanvasElement);
  const histCanvas = mustEl(root, "#hist", HTMLCanvasElement);
  const entCanvas = mustEl(root, "#entropy", HTMLCanvasElement);
  const heat = mustEl(root, "#heat", HTMLInputElement);
  const heatVal = mustEl(root, "#heat-val", HTMLElement);
  const btnSame = mustEl(root, "#btn-same", HTMLButtonElement);
  const btnHalves = mustEl(root, "#btn-halves", HTMLButtonElement);
  const statTemp = mustEl(root, "#stat-temp", HTMLElement);
  const statEnt = mustEl(root, "#stat-entropy", HTMLElement);
  const statColl = mustEl(root, "#stat-coll", HTMLElement);
  const statN = mustEl(root, "#stat-n", HTMLElement);

  const area = stage.clientWidth * stage.clientHeight;
  const aspectOf = (w: number, h: number) => Math.min(4, Math.max(0.4, w / Math.max(1, h)));
  const gas = new Gas(area < 220_000 ? 600 : 850, aspectOf(stage.clientWidth, stage.clientHeight));
  setText(statN, String(gas.n));

  let targetT = 1;
  let preset: Preset = "same";
  let presetAge = 0;
  let wallX: number | null = null;
  let wallAge = 0;
  let clearNext = true;
  let interacted = false;
  const ripples: Ripple[] = [];

  const rawHist = new Float32Array(HIST_BINS);
  const hist = new Float32Array(HIST_BINS);
  let histYMax = 1;

  const series: { t: number[]; v: number[] } = { t: [], v: [] };
  let clock = 0;
  let sampleAcc = 0;
  let entropy = 0;
  let entYMin = -1;
  let collRate = 0;
  let lastColl = 0;
  let frameNo = 0;
  let statsAcc = STATS_DT;

  function sampleEntropy(): void {
    series.t.push(clock);
    series.v.push(entropy);
    while (series.t.length && series.t[0]! < clock - ENTROPY_WINDOW - 1) {
      series.t.shift();
      series.v.shift();
    }
  }

  function applyPreset(p: Preset): void {
    preset = p;
    presetAge = 0;
    gas.reset(p, targetT);
    lastColl = 0;
    wallX = gas.wallX;
    wallAge = 0;
    gas.speedHistogram(hist);
    entropy = gas.entropyGap();
    series.t.length = 0;
    series.v.length = 0;
    sampleEntropy();
    btnSame.classList.toggle("active", p === "same");
    btnHalves.classList.toggle("active", p === "halves");
    clearNext = true;
  }

  function syncHeat(): void {
    heat.value = String(Math.round(tToSlider(targetT)));
    setText(heatVal, kelvin(targetT));
  }

  function noteInteraction(): void {
    interacted = true;
  }

  heat.addEventListener("input", () => {
    noteInteraction();
    targetT = sliderToT(Number(heat.value));
    setText(heatVal, kelvin(targetT));
  });
  btnSame.addEventListener("click", () => {
    noteInteraction();
    applyPreset("same");
  });
  btnHalves.addEventListener("click", () => {
    noteInteraction();
    applyPreset("halves");
  });

  function toSim(ev: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const k = gas.h / Math.max(1, rect.height);
    return { x: (ev.clientX - rect.left) * k, y: (rect.bottom - ev.clientY) * k };
  }

  function burstAt(ev: PointerEvent, strength: number): void {
    const p = toSim(ev);
    gas.burst(p.x, p.y, strength);
    ripples.push({ x: p.x, y: p.y, age: 0 });
    if (ripples.length > 12) ripples.shift();
    let t = gas.temperature();
    if (t > T_MAX) {
      gas.scaleVelocities(Math.sqrt(T_MAX / t));
      t = T_MAX;
    }
    targetT = t;
    syncHeat();
  }

  let dragging = false;
  let lastBurst = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    noteInteraction();
    dragging = true;
    lastBurst = performance.now();
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      // synthetic events may not be capturable
    }
    burstAt(ev, 1);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const now = performance.now();
    if (now - lastBurst < DRAG_BURST_MS) return;
    lastBurst = now;
    burstAt(ev, 0.5);
  });
  const endDrag = (): void => {
    dragging = false;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  function fit(el: HTMLCanvasElement, dpr: number): { w: number; h: number; changed: boolean } {
    const w = el.clientWidth;
    const h = el.clientHeight;
    return { w, h, changed: fitCanvas(el, w, h, dpr) };
  }

  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;
    presetAge += dt;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Size first, then draw in the same frame, so a resize never shows a blank canvas.
    const st = fit(canvas, dpr);
    if (st.changed) {
      gas.setAspect(aspectOf(st.w, st.h));
      if (wallX !== null) wallX = gas.w / 2;
      clearNext = true;
    }

    const t = gas.temperature();
    if (t > 0 && Math.abs(t - targetT) > 1e-4 * targetT) {
      const next = t + (targetT - t) * Math.min(1, dt * HEAT_RATE);
      gas.scaleVelocities(Math.sqrt(next / t));
    }

    if (wallX !== null) {
      wallAge += dt;
      if (wallAge >= WALL_HOLD) gas.wallX = null;
      if (wallAge >= WALL_HOLD + WALL_LIFT) wallX = null;
    }

    gas.step(dt);

    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i]!.age += dt;
      if (ripples[i]!.age >= RIPPLE_LIFE) ripples.splice(i, 1);
    }

    // Measurements
    const v2 = gas.meanV2();
    gas.speedHistogram(rawHist);
    const a = Math.min(1, dt * 9);
    for (let k = 0; k < HIST_BINS; k++) hist[k] += (rawHist[k]! - hist[k]!) * a;
    histYMax += (maxwellPeak(v2) * 1.7 - histYMax) * Math.min(1, dt * 5);

    entropy += (gas.entropyGap() - entropy) * Math.min(1, dt * 6);
    sampleAcc += dt;
    if (sampleAcc >= SAMPLE_DT) {
      sampleAcc = 0;
      sampleEntropy();
    }
    let lo = -0.4;
    for (const v of series.v) lo = Math.min(lo, v);
    entYMin += (lo * 1.1 - entYMin) * Math.min(1, dt * 4);

    const dc = gas.collisions - lastColl;
    lastColl = gas.collisions;
    if (dt > 0) collRate += (dc / dt - collRate) * Math.min(1, dt * 2);

    if (!recordMode && !interacted && presetAge > TOUR_DWELL) {
      applyPreset(preset === "same" ? "halves" : "same");
    }

    drawStage(canvas, st.w, st.h, dpr, gas, {
      ripples,
      wallX,
      wallLift: wallX === null ? 1 : Math.max(0, (wallAge - WALL_HOLD) / WALL_LIFT),
      wallPulse: wallAge,
      clear: clearNext,
    });
    clearNext = false;

    const hc = fit(histCanvas, dpr);
    const ec = fit(entCanvas, dpr);
    if (frameNo++ % CHART_EVERY === 0 || hc.changed || ec.changed) {
      drawHistogram(histCanvas, hc.w, hc.h, dpr, hist, v2, histYMax);
      drawEntropy(entCanvas, ec.w, ec.h, dpr, series.t, series.v, clock, entYMin);
    }

    statsAcc += dt;
    if (statsAcc >= STATS_DT) {
      statsAcc = 0;
      setText(statTemp, kelvin(gas.temperature()));
      setText(statEnt, signed(entropy));
      setText(statColl, String(Math.round(collRate / 10) * 10));
    }

    requestAnimationFrame(frame);
  }

  applyPreset("same");
  histYMax = maxwellPeak(gas.meanV2()) * 1.7;
  syncHeat();
  requestAnimationFrame(frame);
}

mount();
