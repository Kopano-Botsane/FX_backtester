import type { Bar, TF } from '../types';
import { TF_MS } from '../types';

/** Raw gaps longer than this are closed sessions (weekends, long holidays). */
export const GAP_THRESHOLD_MS = 12 * 3_600_000;
/**
 * Display width of a compressed gap. Small enough to look like a session
 * break, large enough that the Friday close and Sunday open candles do not
 * fuse into each other.
 */
export const GAP_EPSILON_MS = 5 * 60_000;

interface Gap {
  /** Raw interval [s, e) that is dropped from the display axis. */
  s: number;
  e: number;
}

/**
 * Session-gap calendar: remaps epoch time onto a compressed display axis in
 * which long dead stretches (weekend, holidays) occupy a fixed small gap.
 *
 * The mapping is piecewise linear and strictly monotonic on live data, so
 * every timeframe, pane, drawing, and the crosshair agree on x positions:
 * a timestamp always maps to the same x in every pane. Compression is applied
 * once at the projection layer; all features that compare or store times
 * (drawings, pending orders, seek targets) keep raw epoch time.
 */
export class GapCalendar {
  private ranges: Gap[] = [];

  reset(): void {
    this.ranges = [];
  }

  /**
   * Rebuild gap intervals from a bar series. Bars must come from the finest
   * available timeframe so daily session breaks are not misread as gaps.
   */
  syncFromBars(bars: Bar[]): void {
    if (bars.length < 2) return;
    const found: Gap[] = [];
    for (let i = 1; i < bars.length; i++) {
      const dt = bars[i].t - bars[i - 1].t;
      if (dt > GAP_THRESHOLD_MS) found.push({ s: bars[i - 1].t, e: bars[i].t });
    }
    if (!found.length) return;
    // Union against the existing calendar; replay only ever appends gaps in
    // chronological order, but a seek/truncate can shrink the series, so
    // rebuild from scratch to stay exact.
    this.ranges = mergeGaps(this.ranges, found);
  }

  /** True while t is inside a dropped interval (no live data there). */
  insideGap(t: number): boolean {
    for (const g of this.ranges) {
      if (t >= g.e) continue;
      return t > g.s;
    }
    return false;
  }

  /** Epoch time → display-axis time. */
  compress(t: number): number {
    const g = this.ranges;
    let drop = 0;
    for (let i = 0; i < g.length; i++) {
      if (t >= g[i].e) drop += g[i].e - g[i].s - GAP_EPSILON_MS;
      else if (t > g[i].s) return g[i].s - drop; // inside a gap: pin to its start
      else break;
    }
    return t - drop;
  }

  /** Display-axis time → epoch time (inverse of compress). */
  uncompress(d: number): number {
    const g = this.ranges;
    let drop = 0;
    for (let i = 0; i < g.length; i++) {
      const ds = g[i].s - drop; // display position of the gap start
      const de = ds + GAP_EPSILON_MS;
      if (d < ds) return d + drop;
      if (d <= de) return g[i].s; // inside the epsilon: snap to gap start
      drop += g[i].e - g[i].s - GAP_EPSILON_MS;
    }
    return d + drop;
  }
}

/** Sorted, non-overlapping union of two gap sets. */
function mergeGaps(a: Gap[], b: Gap[]): Gap[] {
  const all = [...a, ...b].sort((p, q) => p.s - q.s);
  const out: Gap[] = [];
  for (const g of all) {
    const last = out[out.length - 1];
    if (last && g.s <= last.e) {
      if (g.e > last.e) last.e = g.e;
    } else {
      out.push({ s: g.s, e: g.e });
    }
  }
  return out;
}

/** The finest-timeframe bar series currently loaded (drives gap detection). */
export function finestBars(marketBars: Map<TF, Bar[]>): Bar[] {
  let best: Bar[] = [];
  let bestMs = Infinity;
  for (const [tf, bars] of marketBars) {
    const ms = TF_MS[tf];
    if (bars.length >= 2 && ms < bestMs && tf !== '1d') {
      best = bars;
      bestMs = ms;
    }
  }
  return best;
}
