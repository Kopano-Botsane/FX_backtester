import type { Bar, TF } from '../types';
import { GapCalendar, finestBars } from './gaps';

type MarketListener = (tf: TF | null) => void;

/**
 * Main-thread view of the candle builder worker. Holds one bar array per
 * timeframe; panes read them directly during render.
 */
export class MarketData {
  readonly worker: Worker;
  private bars = new Map<TF, Bar[]>();
  private listeners = new Set<MarketListener>();

  /**
   * Session-gap calendar used by the chart projection to collapse weekend
   * and holiday dead time. Derived from the finest loaded bar series and
   * cleared together with the market data.
   */
  readonly gaps = new GapCalendar();

  lastPrice: number | null = null;
  lastTime: number | null = null;
  tickCount = 0;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent) => this.handle(ev.data);
  }

  subscribe(fn: MarketListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(tf: TF | null): void {
    for (const fn of this.listeners) fn(tf);
  }

  private handle(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'reset': {
        this.bars.clear();
        this.gaps.reset();
        this.lastPrice = null;
        this.lastTime = null;
        this.tickCount = 0;
        this.notify(null);
        break;
      }
      case 'bars': {
        const tf = msg.tf as TF;
        const startIndex = msg.startIndex as number;
        const incoming = msg.bars as Bar[];
        let arr = this.bars.get(tf);
        if (!arr) {
          arr = [];
          this.bars.set(tf, arr);
        }
        if (startIndex <= arr.length) arr.length = startIndex;
        for (const bar of incoming) arr.push(bar);
        this.gaps.syncFromBars(finestBars(this.bars));
        this.notify(tf);
        break;
      }
      case 'progress': {
        this.lastPrice = msg.price as number;
        this.lastTime = msg.time as number;
        this.tickCount = msg.count as number;
        this.notify(null);
        break;
      }
    }
  }

  barsFor(tf: TF): Bar[] {
    return this.bars.get(tf) ?? EMPTY;
  }

  /** Inject pre-aggregated OHLCV bars directly (for prehistory). */
  preloadBars(tf: TF, bars: Bar[]): void {
    if (!bars.length) return;
    // Seed the worker: it owns bar state, so replay ticks aggregate on top of
    // the prehistory instead of restarting empty (which would wipe these bars
    // once the first 'bars' message with startIndex 0 arrives).
    this.worker.postMessage({ type: 'preload', tf, bars });
    // Mirror immediately so panes can render before the worker round-trip.
    // The worker's echo is idempotent: startIndex 0 truncates and re-pushes
    // the same series.
    this.bars.set(tf, bars.slice());
    this.gaps.syncFromBars(finestBars(this.bars));
    this.notify(tf);
  }

  /** Seek: tell the worker to drop bars at/after the cursor (per timeframe). */
  truncateTo(time: number): void {
    this.worker.postMessage({ type: 'truncate', time });
  }

  append(t: ArrayLike<number>, p: ArrayLike<number>, s: ArrayLike<number>): void {
    if (!t.length) return;
    // Binary frames arrive as three Float64Array views on ONE ArrayBuffer.
    // Transfer that buffer to the worker once: zero clone, and the main
    // thread never touches the samples again.
    if (
      t instanceof Float64Array &&
      p instanceof Float64Array &&
      s instanceof Float64Array
    ) {
      const shared =
        p.buffer === t.buffer && (s as Float64Array).buffer === t.buffer;
      this.worker.postMessage(
        { type: 'append', t, p, s },
        shared ? [t.buffer] : [],
      );
      return;
    }
    this.worker.postMessage({ type: 'append', t, p, s });
  }

  reset(): void {
    this.worker.postMessage({ type: 'reset' });
    // Clear eagerly so a stale frame cannot paint the previous session.
    this.bars.clear();
    this.gaps.reset();
    this.lastPrice = null;
    this.lastTime = null;
    this.tickCount = 0;
  }

  destroy(): void {
    this.worker.terminate();
  }
}

const EMPTY: Bar[] = [];
