import type { MarketData } from '../data/market';
import type { Store } from '../store';
import {
  TF_LIST,
  TF_MS,
  type AppState,
  type Bar,
  type Drawing,
  type DrawingKind,
  type PaneState,
  type Point,
} from '../types';
import { clamp, fmtPrice, fmtPriceAxis, fmtTime, lowerBound, niceStep } from '../util';
import { drawDrawing, hitTestDrawing, hitTestHandle, type Projection, type Rect } from './drawings';

export interface ChartHost {
  store: Store;
  market: MarketData;
  focusPane(id: string): void;
  setView(id: string, rightTime: number, pxPerMs: number, follow?: boolean): void;
  patchPane(id: string, patch: Partial<PaneState>, emit?: boolean): void;
  commitDrawing(kind: DrawingKind, a: Point, b: Point): void;
  updateDrawing(id: string, patch: Pick<Drawing, 'a' | 'b'>): void;
  select(id: string | null): void;
  removeDrawing(id: string): void;
  closePane(id: string): void;
  setCrosshair(c: AppState['crosshair']): void;
}

const COLORS = {
  bg: '#0a0d12',
  panel: '#11161d',
  grid: '#1a222c',
  border: '#232c38',
  text: '#d7dee8',
  muted: '#7c8a9c',
  up: '#26a69a',
  down: '#ef5350',
  cross: '#8f9dae',
  accent: '#4c8dff',
};

const GUTTER_R = 66;
const GUTTER_B = 22;
const TIME_STEPS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 14_400_000, 21_600_000,
  43_200_000, 86_400_000, 172_800_000, 604_800_000, 1_209_600_000, 2_592_000_000,
  7_776_000_000, 15_552_000_000, 31_536_000_000,
];

function timeStepFor(pxPerMs: number): number {
  const target = 86;
  for (const step of TIME_STEPS) if (step * pxPerMs >= target) return step;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; rightTime: number; minP: number; maxP: number; pxPerMs: number }
  | { kind: 'yscale'; startY: number; anchor: number; minP: number; maxP: number }
  | { kind: 'xscale'; startX: number; anchorTime: number; pxPerMs: number }
  | { kind: 'move'; id: string; startT: number; startP: number; a: Point; b: Point }
  | { kind: 'handle'; id: string; handle: 'a' | 'b' }
  | { kind: 'create'; kind2: DrawingKind; a: Point; b: Point; startX: number; startY: number; moved: boolean };

interface View {
  plot: Rect;
  rightTime: number;
  pxPerMs: number;
  minP: number;
  maxP: number;
  proj: Projection;
}

export class ChartPane {
  readonly el: HTMLDivElement;
  private host: ChartHost;
  private id: string;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private frame = 0;
  private view: View | null = null;
  private drag: Drag | null = null;
  private preview: Drawing | null = null;
  private hoverId: string | null = null;
  private unsubs: (() => void)[] = [];

  private symEl: HTMLSpanElement;
  private tfSelect: HTMLSelectElement;
  private lastEl: HTMLSpanElement;
  private chgEl: HTMLSpanElement;

  constructor(host: ChartHost, id: string) {
    this.host = host;
    this.id = id;

    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.dataset.paneId = id;
    this.el.innerHTML = `
      <div class="pane-head">
        <span class="pane-symbol"></span>
        <select class="pane-tf" title="Timeframe"></select>
        <span class="pane-last"></span>
        <span class="pane-chg"></span>
        <span class="spacer"></span>
        <button class="pane-follow" title="Jump to the latest tick">&#9197;</button>
        <button class="pane-close" title="Close pane">&times;</button>
      </div>
      <canvas></canvas>
      <div class="empty">Waiting for ticks&hellip;</div>
    `;

    this.symEl = this.el.querySelector('.pane-symbol')!;
    this.tfSelect = this.el.querySelector('.pane-tf')!;
    this.lastEl = this.el.querySelector('.pane-last')!;
    this.chgEl = this.el.querySelector('.pane-chg')!;
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;

    for (const tf of TF_LIST) {
      const opt = document.createElement('option');
      opt.value = tf;
      opt.textContent = tf;
      this.tfSelect.appendChild(opt);
    }

    this.tfSelect.addEventListener('change', () => {
      this.host.patchPane(this.id, { tf: this.tfSelect.value as PaneState['tf'], autoScale: true });
      this.host.focusPane(this.id);
    });
    this.el.querySelector('.pane-follow')!.addEventListener('click', () => this.jumpToLatest());
    this.el.querySelector('.pane-close')!.addEventListener('click', () => this.host.closePane(this.id));

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.el);

    this.unsubs.push(host.store.subscribe(() => this.schedule()));
    this.unsubs.push(host.market.subscribe(() => this.schedule()));

    const pane = host.store.pane(id);
    if (pane) this.tfSelect.value = pane.tf;
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    for (const un of this.unsubs) un();
    this.el.remove();
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private jumpToLatest(): void {
    const pane = this.host.store.pane(this.id);
    if (!pane) return;
    const target = this.host.market.lastTime ?? this.host.store.state.replay.time;
    this.host.setView(this.id, target + TF_MS[pane.tf], pane.pxPerMs, true);
  }

  // ---------------------------------------------------------------- projection

  private canvasSize(): { cw: number; ch: number } {
    return { cw: this.canvas.clientWidth, ch: this.canvas.clientHeight };
  }

  private makeView(pane: PaneState, cw: number, ch: number, bars: Bar[]): View {
    const plot: Rect = { x: 0, y: 0, w: Math.max(10, cw - GUTTER_R), h: Math.max(10, ch - GUTTER_B) };
    const rightTime = pane.rightTime;
    const pxPerMs = pane.pxPerMs;
    const plotRight = plot.x + plot.w;

    let minP = pane.priceMin;
    let maxP = pane.priceMax;

    if (pane.autoScale) {
      const fitted = this.fitPrice(bars, pane, plot, rightTime, pxPerMs);
      if (fitted) {
        minP = fitted[0];
        maxP = fitted[1];
      }
    }
    const tick = Math.pow(10, -this.host.store.state.digits);
    if (!isFinite(minP) || !isFinite(maxP) || maxP - minP < tick * 4) {
      maxP = minP + tick * 20;
    }

    const span = maxP - minP;
    const proj: Projection = {
      plot,
      digits: this.host.store.state.digits,
      timeToX: (t) => plotRight - (rightTime - t) * pxPerMs,
      priceToY: (p) => plot.y + ((maxP - p) / span) * plot.h,
      xToTime: (x) => rightTime - (plotRight - x) / pxPerMs,
      yToPrice: (y) => maxP - ((y - plot.y) / plot.h) * span,
    };
    return { plot, rightTime, pxPerMs, minP, maxP, proj };
  }

  private fitPrice(
    bars: Bar[],
    pane: PaneState,
    plot: Rect,
    rightTime: number,
    pxPerMs: number,
  ): [number, number] | null {
    if (!bars.length) return null;
    const tfMs = TF_MS[pane.tf];
    const left = rightTime - plot.w / pxPerMs;
    let from = lowerBound(bars, left - tfMs);
    let to = lowerBound(bars, rightTime + tfMs * 2);
    if (to <= from) {
      from = Math.max(0, bars.length - 60);
      to = bars.length;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to; i++) {
      const bar = bars[i];
      if (bar.l < lo) lo = bar.l;
      if (bar.h > hi) hi = bar.h;
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    const tick = Math.pow(10, -this.host.store.state.digits);
    const pad = Math.max((hi - lo) * 0.08, tick * 6);
    return [lo - pad, hi + pad];
  }

  private currentView(): View | null {
    const pane = this.host.store.pane(this.id);
    if (!pane) return null;
    const { cw, ch } = this.canvasSize();
    if (cw <= 0 || ch <= 0) return null;
    const bars = this.host.market.barsFor(pane.tf);
    return this.makeView(pane, cw, ch, bars);
  }

  private pointer(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    const pane = this.host.store.pane(this.id);
    if (!pane) return;

    const { cw, ch } = this.canvasSize();
    if (cw === 0 || ch === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cw, ch);

    const bars = this.host.market.barsFor(pane.tf);
    const tfMs = TF_MS[pane.tf];

    if (!pane.viewReady) {
      const anchor = this.host.market.lastTime ?? this.host.store.state.replay.time;
      const pxPerMs = pane.pxPerMs > 0 ? pane.pxPerMs : cw / (tfMs * 130);
      const margin = pxPerMs > 0 ? 0.02 * (cw / pxPerMs) : 0;
      this.host.patchPane(
        this.id,
        { pxPerMs, rightTime: anchor + margin, viewReady: true, follow: true, autoScale: true },
        false,
      );
    }

    const view = this.makeView(pane, cw, ch, bars);
    this.view = view;
    const { plot, proj } = view;
    if (Math.abs(pane.plotWidth - plot.w) > 0.5) {
      this.host.patchPane(this.id, { plotWidth: plot.w }, false);
    }

    this.updateHeader(pane, bars);

    this.drawGrid(view);
    this.drawWatermark(view, pane);

    if (bars.length) {
      this.drawCandles(view, bars, tfMs);
    } else {
      this.el.classList.add('is-empty');
    }
    if (bars.length) this.el.classList.remove('is-empty');

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    const { drawings, selectedId } = this.host.store.state;
    for (const d of drawings) {
      drawDrawing(ctx, d, proj, d.id === selectedId, d.id === this.hoverId);
    }
    if (this.preview) drawDrawing(ctx, this.preview, proj, true, false);
    ctx.restore();

    this.drawAxes(view);
    if (bars.length) this.drawLastPrice(view, bars);
    this.drawCrosshair(view);
    this.drawLegend(bars, tfMs);
  }

  private updateHeader(pane: PaneState, bars: Bar[]): void {
    const symbol = this.host.store.state.symbol;
    if (this.symEl.textContent !== symbol) this.symEl.textContent = symbol;
    if (this.tfSelect.value !== pane.tf) this.tfSelect.value = pane.tf;

    const last = bars[bars.length - 1];
    if (!last) {
      this.lastEl.textContent = '';
      this.chgEl.textContent = '';
      return;
    }
    const digits = this.host.store.state.digits;
    const text = fmtPrice(last.c, digits);
    if (this.lastEl.textContent !== text) {
      this.lastEl.textContent = text;
      this.lastEl.style.color = last.c >= last.o ? COLORS.up : COLORS.down;
    }
    const open = bars[0].o || last.o;
    const pct = ((last.c - open) / open) * 100;
    const chg = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    if (this.chgEl.textContent !== chg) {
      this.chgEl.textContent = chg;
      this.chgEl.className = `pane-chg ${pct >= 0 ? 'up' : 'down'}`;
    }
  }

  private drawGrid(view: View): void {
    const ctx = this.ctx;
    const { plot, minP, maxP, pxPerMs, rightTime } = view;
    const plotRight = plot.x + plot.w;

    const pStep = niceStep(maxP - minP, Math.max(2, Math.round(plot.h / 64)));
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const pStart = Math.ceil(minP / pStep) * pStep;
    for (let p = pStart; p <= maxP; p += pStep) {
      const y = Math.round(view.proj.priceToY(p)) + 0.5;
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plotRight, y);
    }
    const tStep = timeStepFor(pxPerMs);
    const tStart = Math.ceil(view.proj.xToTime(plot.x) / tStep) * tStep;
    for (let t = tStart; t <= rightTime + tStep; t += tStep) {
      const x = Math.round(view.proj.timeToX(t)) + 0.5;
      if (x < plot.x || x > plotRight) continue;
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    ctx.stroke();

    // Axis frames
    ctx.strokeStyle = COLORS.border;
    ctx.beginPath();
    ctx.moveTo(plotRight + 0.5, 0);
    ctx.lineTo(plotRight + 0.5, plot.y + plot.h);
    ctx.moveTo(0, plot.y + plot.h + 0.5);
    ctx.lineTo(plotRight, plot.y + plot.h + 0.5);
    ctx.stroke();
  }

  private drawWatermark(view: View, pane: PaneState): void {
    const { plot } = view;
    if (plot.w < 240) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = COLORS.text;
    ctx.font = '700 40px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${this.host.store.state.symbol}  ${pane.tf}`, plot.x + plot.w / 2, plot.y + plot.h / 2);
    ctx.restore();
  }

  private drawCandles(view: View, bars: Bar[], tfMs: number): void {
    const ctx = this.ctx;
    const { plot, proj } = view;
    const barW = tfMs * view.pxPerMs;
    const bodyW = Math.max(1, Math.min(barW * 0.68, 28));
    const leftTime = proj.xToTime(plot.x) - tfMs * 2;
    const rightTime = proj.xToTime(plot.x + plot.w) + tfMs;
    let i = lowerBound(bars, leftTime);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    for (; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.t > rightTime) break;
      const x = proj.timeToX(bar.t + tfMs / 2);
      if (x < plot.x - barW || x > plot.x + plot.w + barW) continue;

      const up = bar.c >= bar.o;
      const color = up ? COLORS.up : COLORS.down;
      const yO = proj.priceToY(bar.o);
      const yC = proj.priceToY(bar.c);
      const yH = proj.priceToY(bar.h);
      const yL = proj.priceToY(bar.l);

      if (barW < 2.6) {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x) - 0.5, Math.round(yH), 1, Math.max(1, Math.round(yL - yH)));
        continue;
      }

      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x) - 0.5, Math.round(yH), 1, Math.max(1, Math.round(yL - yH)));
      const top = Math.min(yO, yC);
      const height = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(Math.round(x - bodyW / 2), Math.round(top), Math.round(bodyW), Math.round(height));
    }
    ctx.restore();
  }

  private drawLastPrice(view: View, bars: Bar[]): void {
    const ctx = this.ctx;
    const last = bars[bars.length - 1];
    const digits = this.host.store.state.digits;
    const y = view.proj.priceToY(last.c);
    const up = last.c >= last.o;
    const color = up ? COLORS.up : COLORS.down;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(view.plot.x, Math.round(y) + 0.5);
    ctx.lineTo(view.plot.x + view.plot.w, Math.round(y) + 0.5);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    const tagH = 16;
    ctx.fillRect(view.plot.x + view.plot.w + 1, y - tagH / 2, GUTTER_R - 1, tagH);
    ctx.fillStyle = '#08110f';
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(last.c, digits), view.plot.x + view.plot.w + 6, y + 0.5);
    ctx.restore();
  }

  private drawAxes(view: View): void {
    const ctx = this.ctx;
    const { plot, minP, maxP, pxPerMs, rightTime } = view;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const digits = this.host.store.state.digits;

    // Solid gutters so candles never bleed into the labels.
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(plot.x + plot.w + 1, 0, GUTTER_R, plot.y + plot.h + 1);
    ctx.fillRect(0, plot.y + plot.h + 1, cw, GUTTER_B);

    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = COLORS.muted;
    ctx.textBaseline = 'middle';

    const pStep = niceStep(maxP - minP, Math.max(2, Math.round(plot.h / 64)));
    ctx.textAlign = 'right';
    const pStart = Math.ceil(minP / pStep) * pStep;
    for (let p = pStart; p <= maxP; p += pStep) {
      const y = view.proj.priceToY(p);
      if (y < 8 || y > plot.y + plot.h - 6) continue;
      ctx.fillText(fmtPriceAxis(p, digits, pStep), plot.x + plot.w + GUTTER_R - 6, y);
    }

    ctx.textAlign = 'center';
    const tStep = timeStepFor(pxPerMs);
    const tStart = Math.ceil(view.proj.xToTime(plot.x) / tStep) * tStep;
    const label = (t: number) =>
      tStep >= 604_800_000 ? fmtTime(t, 604_800_000) : fmtTime(t, tStep);
    for (let t = tStart; t <= rightTime + tStep; t += tStep) {
      const x = view.proj.timeToX(t);
      if (x < plot.x + 26 || x > plot.x + plot.w - 22) continue;
      ctx.fillText(label(t), x, ch - GUTTER_B / 2);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = '#5b6878';
    ctx.fillText('UTC', plot.x + plot.w - 4, ch - GUTTER_B / 2);
  }

  private drawCrosshair(view: View): void {
    const cross = this.host.store.state.crosshair;
    if (!cross) return;
    const ctx = this.ctx;
    const { plot, proj } = view;
    const x = proj.timeToX(cross.time);
    if (!isFinite(x)) return;

    ctx.save();
    ctx.strokeStyle = COLORS.cross;
    ctx.globalAlpha = 0.65;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    if (x >= plot.x && x <= plot.x + plot.w) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.y);
      ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
      ctx.stroke();
    }

    if (cross.source === this.id) {
      const y = proj.priceToY(cross.price);
      if (y >= plot.y && y <= plot.y + plot.h) {
        ctx.beginPath();
        ctx.moveTo(plot.x, Math.round(y) + 0.5);
        ctx.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Time tag on the bottom axis.
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    const timeLabel = fmtTime(cross.time, 1000);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(timeLabel).width + 12;
    const tx = clamp(x - tw / 2, 1, this.canvas.clientWidth - GUTTER_R - tw - 2);
    ctx.fillStyle = '#3a4656';
    ctx.fillRect(tx, plot.y + plot.h + 2, tw, GUTTER_B - 4);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(timeLabel, tx + tw / 2, this.canvas.clientHeight - GUTTER_B / 2);

    // Price tag only in the pane that owns the pointer.
    if (cross.source === this.id) {
      const y = clamp(proj.priceToY(cross.price), 8, plot.y + plot.h - 8);
      const priceLabel = fmtPrice(cross.price, this.host.store.state.digits);
      const pw = ctx.measureText(priceLabel).width + 12;
      ctx.fillStyle = '#3a4656';
      ctx.fillRect(plot.x + plot.w + 2, y - 9, Math.min(pw, GUTTER_R - 4), 18);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(priceLabel, plot.x + plot.w + 7, y);
    }
    ctx.restore();
  }

  private drawLegend(bars: Bar[], tfMs: number): void {
    if (!bars.length) return;
    const cross = this.host.store.state.crosshair;
    let bar = bars[bars.length - 1];
    if (cross) {
      const idx = lowerBound(bars, cross.time + 1) - 1;
      if (idx >= 0 && idx < bars.length) bar = bars[idx];
    }
    const ctx = this.ctx;
    const digits = this.host.store.state.digits;
    const parts: [string, string, string][] = [
      ['O', fmtPrice(bar.o, digits), COLORS.muted],
      ['H', fmtPrice(bar.h, digits), COLORS.muted],
      ['L', fmtPrice(bar.l, digits), COLORS.muted],
      ['C', fmtPrice(bar.c, digits), bar.c >= bar.o ? COLORS.up : COLORS.down],
    ];
    const open = bars[0].o || bar.o;
    const pct = ((bar.c - open) / open) * 100;
    parts.push(['', `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, pct >= 0 ? COLORS.up : COLORS.down]);

    ctx.save();
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let x = 8;
    const y = 7;
    for (const [key, value, color] of parts) {
      if (key) {
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(key, x, y);
        x += ctx.measureText(key).width + 3;
      }
      ctx.fillStyle = color;
      ctx.fillText(value, x, y);
      x += ctx.measureText(value).width + 9;
    }
    ctx.fillStyle = '#55637a';
    ctx.fillText(fmtTime(bar.t, tfMs), x, y);
    ctx.restore();
  }

  // ---------------------------------------------------------------- interaction

  private topDrawing(x: number, y: number): Drawing | null {
    const view = this.view;
    if (!view) return null;
    const drawings = this.host.store.state.drawings;
    for (let i = drawings.length - 1; i >= 0; i--) {
      if (hitTestDrawing(drawings[i], view.proj, x, y)) return drawings[i];
    }
    return null;
  }

  private zoneAt(x: number, y: number): 'plot' | 'price' | 'time' {
    const view = this.view;
    if (!view) return 'plot';
    const { plot } = view;
    if (x > plot.x + plot.w) return 'price';
    if (y > plot.y + plot.h) return 'time';
    return 'plot';
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.host.focusPane(this.id);
    const { x, y } = this.pointer(e);
    const view = this.currentView();
    if (!view) return;
    this.view = view;
    const zone = this.zoneAt(x, y);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const state = this.host.store.state;

    if (zone === 'price') {
      this.drag = {
        kind: 'yscale',
        startY: y,
        anchor: view.proj.yToPrice(y),
        minP: view.minP,
        maxP: view.maxP,
      };
      this.canvas.classList.add('axis-y');
      return;
    }
    if (zone === 'time') {
      this.drag = {
        kind: 'xscale',
        startX: x,
        anchorTime: view.proj.xToTime(x),
        pxPerMs: view.pxPerMs,
      };
      this.canvas.classList.add('axis-x');
      return;
    }

    if (state.tool === 'eraser') {
      const hit = this.topDrawing(x, y);
      if (hit) this.host.removeDrawing(hit.id);
      return;
    }

    if (state.tool === 'cursor') {
      const selected = state.drawings.find((d) => d.id === state.selectedId);
      if (selected) {
        const handle = hitTestHandle(selected, view.proj, x, y);
        if (handle) {
          this.drag = { kind: 'handle', id: selected.id, handle };
          return;
        }
      }
      const hit = this.topDrawing(x, y);
      if (hit) {
        this.host.select(hit.id);
        this.drag = {
          kind: 'move',
          id: hit.id,
          startT: view.proj.xToTime(x),
          startP: view.proj.yToPrice(y),
          a: { ...hit.a },
          b: { ...hit.b },
        };
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      this.host.select(null);
      this.drag = {
        kind: 'pan',
        startX: x,
        startY: y,
        rightTime: view.rightTime,
        minP: view.minP,
        maxP: view.maxP,
        pxPerMs: view.pxPerMs,
      };
      this.canvas.classList.add('grabbing');
      return;
    }

    const point = { t: view.proj.xToTime(x), p: view.proj.yToPrice(y) };
    const kind = state.tool as DrawingKind;
    this.preview = { id: 'preview', kind, a: point, b: { ...point }, color: state.color };
    this.drag = {
      kind: 'create',
      kind2: kind,
      a: point,
      b: { ...point },
      startX: x,
      startY: y,
      moved: false,
    };
  };

  private onPointerMove = (e: PointerEvent): void => {
    const { x, y } = this.pointer(e);
    const view = this.view;
    if (!view) return;
    const state = this.host.store.state;
    const { plot, proj } = view;
    const inside = x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h;

    if (inside) {
      this.host.setCrosshair({ time: proj.xToTime(x), price: proj.yToPrice(y), source: this.id });
    } else if (state.crosshair?.source === this.id) {
      this.host.setCrosshair(null);
    }

    if (!this.drag && inside && (state.tool === 'cursor' || state.tool === 'eraser')) {
      const hit = this.topDrawing(x, y);
      const id = hit?.id ?? null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.canvas.style.cursor = id ? (state.tool === 'eraser' ? 'not-allowed' : 'grab') : '';
        this.schedule();
      }
    }

    const drag = this.drag;
    if (!drag) return;

    switch (drag.kind) {
      case 'pan': {
        const dx = x - drag.startX;
        const dy = y - drag.startY;
        const ppp = (drag.maxP - drag.minP) / plot.h;
        this.host.setView(this.id, drag.rightTime - dx / drag.pxPerMs, drag.pxPerMs, false);
        this.host.patchPane(this.id, {
          priceMin: drag.minP + dy * ppp,
          priceMax: drag.maxP + dy * ppp,
          autoScale: false,
        });
        break;
      }
      case 'yscale': {
        const factor = clamp(Math.exp((y - drag.startY) * 0.006), 0.2, 40);
        const minP = drag.anchor + (drag.minP - drag.anchor) * factor;
        const maxP = drag.anchor + (drag.maxP - drag.anchor) * factor;
        this.host.patchPane(this.id, { priceMin: minP, priceMax: maxP, autoScale: false });
        break;
      }
      case 'xscale': {
        const factor = clamp(Math.exp((x - drag.startX) * 0.006), 0.05, 60);
        const pxPerMs = clamp(drag.pxPerMs * factor, 1e-8, 0.2);
        const rightTime = drag.anchorTime + (plot.x + plot.w - drag.startX) / pxPerMs;
        this.host.setView(this.id, rightTime, pxPerMs, false);
        break;
      }
      case 'move': {
        const dt = proj.xToTime(x) - drag.startT;
        const dp = proj.yToPrice(y) - drag.startP;
        this.host.updateDrawing(drag.id, {
          a: { t: drag.a.t + dt, p: drag.a.p + dp },
          b: { t: drag.b.t + dt, p: drag.b.p + dp },
        });
        break;
      }
      case 'handle': {
        const point = { t: proj.xToTime(x), p: proj.yToPrice(y) };
        const drawing = state.drawings.find((d) => d.id === drag.id);
        if (!drawing) break;
        this.host.updateDrawing(drag.id, {
          a: drag.handle === 'a' ? point : drawing.a,
          b: drag.handle === 'b' ? point : drawing.b,
        });
        break;
      }
      case 'create': {
        drag.b = { t: proj.xToTime(x), p: proj.yToPrice(y) };
        if (Math.hypot(x - drag.startX, y - drag.startY) > 3) drag.moved = true;
        if (this.preview) this.preview = { ...this.preview, b: drag.b };
        this.schedule();
        break;
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    this.canvas.classList.remove('grabbing', 'axis-x', 'axis-y');
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }

    if (drag?.kind === 'create') {
      const { kind2, a, b, moved } = drag;
      this.preview = null;
      if (kind2 === 'hline' || moved) {
        this.host.commitDrawing(kind2, a, kind2 === 'hline' ? { t: b.t, p: a.p } : b);
      }
      this.schedule();
    }
    if (!drag && this.canvas.style.cursor === 'grabbing') this.canvas.style.cursor = '';
  };

  private onPointerLeave = (): void => {
    if (this.host.store.state.crosshair?.source === this.id) this.host.setCrosshair(null);
    if (!this.drag) {
      this.hoverId = null;
      this.schedule();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const view = this.view ?? this.currentView();
    if (!view) return;
    this.view = view;
    const { x, y } = this.pointer(e);
    const zone = this.zoneAt(x, y);
    const { plot, proj } = view;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;

    if (e.shiftKey) {
      this.host.setView(this.id, view.rightTime + (delta / view.pxPerMs) * 0.6, view.pxPerMs, false);
      return;
    }

    if (zone === 'price') {
      const factor = clamp(Math.exp(delta * 0.0018), 0.5, 2.2);
      const anchor = proj.yToPrice(y);
      this.host.patchPane(this.id, {
        priceMin: anchor + (view.minP - anchor) * factor,
        priceMax: anchor + (view.maxP - anchor) * factor,
        autoScale: false,
      });
      return;
    }

    const factor = clamp(Math.exp(delta * 0.0015), 0.35, 3);
    const pxPerMs = clamp(view.pxPerMs / factor, 1e-8, 0.2);
    const anchorTime = proj.xToTime(x);
    const rightTime = anchorTime + (plot.x + plot.w - x) / pxPerMs;
    this.host.setView(this.id, rightTime, pxPerMs, false);
  };

  private onDoubleClick = (e: MouseEvent): void => {
    if (!this.view) return;
    const { x, y } = this.pointer(e);
    const zone = this.zoneAt(x, y);
    const pane = this.host.store.pane(this.id);
    if (!pane) return;

    if (zone === 'price') {
      this.host.patchPane(this.id, { autoScale: true });
      return;
    }
    if (zone === 'time') {
      const { cw } = this.canvasSize();
      const pxPerMs = cw / (TF_MS[pane.tf] * 130);
      const target = this.host.market.lastTime ?? this.host.store.state.replay.time;
      this.host.setView(this.id, target + TF_MS[pane.tf] * 2, pxPerMs, true);
      this.host.patchPane(this.id, { autoScale: true });
      return;
    }
    this.host.patchPane(this.id, { autoScale: true });
  };
}
