import type { Bar, TF } from '../types';

type MarketListener = (tf: TF | null) => void;

/**
 * Main-thread view of the candle builder worker. Holds one bar array per
 * timeframe; panes read them directly during render.
 */
export class MarketData {
  readonly worker: Worker;
  private bars = new Map<TF, Bar[]>();
  private listeners = new Set<MarketListener>();

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

  append(t: number[], p: number[], s: number[]): void {
    if (!t.length) return;
    this.worker.postMessage({ type: 'append', t, p, s });
  }

  reset(): void {
    this.worker.postMessage({ type: 'reset' });
    // Clear eagerly so a stale frame cannot paint the previous session.
    this.bars.clear();
    this.lastPrice = null;
    this.lastTime = null;
    this.tickCount = 0;
  }

  destroy(): void {
    this.worker.terminate();
  }
}

const EMPTY: Bar[] = [];
