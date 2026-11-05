/// <reference lib="webworker" />
import { TF_LIST, TF_MS, type Bar, type TF } from '../types';

/**
 * Candle builder. Owns the raw tape and aggregates it into every timeframe
 * simultaneously, so switching a pane's timeframe needs no refetch.
 *
 * Protocol in:
 *   {type:'append', t[], p[], s[]}
 *   {type:'preload', tf, bars[]}            // seed prehistory bars before ticks
 *   {type:'truncate', time}                 // seek: drop bars at/after cursor
 *   {type:'reset'}
 * Protocol out:
 *   {type:'reset'}
 *   {type:'bars', tf, startIndex, bars[]}   // replaces/happens at startIndex
 *   {type:'progress', time, price, count}
 */

interface TFState {
  bars: Bar[];
  /** Index of the first bar that has never been emitted. */
  emitted: number;
}

const states = new Map<string, TFState>();
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let lastTime = 0;
let count = 0;

function stateFor(tf: string): TFState {
  let st = states.get(tf);
  if (!st) {
    st = { bars: [], emitted: 0 };
    states.set(tf, st);
  }
  return st;
}

function preload(tf: TF, bars: Bar[]): void {
  // Seed a timeframe with prehistory bars so tick aggregation continues from
  // them instead of restarting from an empty series (which would wipe the
  // prehistory on the main thread via the startIndex-truncation in 'bars').
  const st = stateFor(tf);
  st.bars = bars.slice();
  st.emitted = st.bars.length;
  // Give the main thread the seeded series through the normal path.
  ctx.postMessage({ type: 'bars', tf, startIndex: 0, bars: st.bars });
}

function truncate(time: number): void {
  // Seek: drop bars at/after the cursor's bar start in every timeframe. The
  // bar containing the cursor is rebuilt from the history chunks the server
  // re-sends after a seek. Bars before the cursor — including seeded
  // prehistory — are kept untouched.
  const changed: TF[] = [];
  for (const tf of TF_LIST) {
    const st = stateFor(tf);
    const cutoff = Math.floor(time / TF_MS[tf]) * TF_MS[tf];
    const bars = st.bars;
    let n = bars.length;
    while (n > 0 && bars[n - 1].t >= cutoff) n--;
    if (n < bars.length) {
      bars.length = n;
      st.emitted = Math.min(st.emitted, n);
      changed.push(tf);
    }
  }
  for (const tf of changed) {
    // Empty payload with the truncation index: the client cuts its mirror to
    // this length through the normal 'bars' path.
    const st = stateFor(tf);
    ctx.postMessage({ type: 'bars', tf, startIndex: st.emitted, bars: [] });
  }
}

function reset(): void {
  states.clear();
  lastTime = 0;
  count = 0;
  ctx.postMessage({ type: 'reset' });
}

function append(t: ArrayLike<number>, p: ArrayLike<number>, s: ArrayLike<number>): void {
  if (!t.length) return;

  const changed: string[] = [];

  for (const tf of TF_LIST) {
    const ms = TF_MS[tf];
    const st = stateFor(tf);
    const bars = st.bars;
    let touched = false;

    for (let i = 0; i < t.length; i++) {
      const ts = t[i];
      const price = p[i];
      const size = s[i] || 0;
      if (!isFinite(ts) || !isFinite(price)) continue;

      const barTime = Math.floor(ts / ms) * ms;
      const n = bars.length;

      if (n > 0 && barTime < bars[n - 1].t) {
        continue; // stale / out-of-order tick
      }

      if (n > 0 && bars[n - 1].t === barTime) {
        const bar = bars[n - 1];
        bar.c = price;
        if (price > bar.h) bar.h = price;
        if (price < bar.l) bar.l = price;
        bar.v += size;
      } else {
        bars.push({ t: barTime, o: price, h: price, l: price, c: price, v: size });
      }
      touched = true;
    }

    if (touched) changed.push(tf);
  }

  for (const tf of changed) {
    const st = stateFor(tf);
    // Re-emit the last (still forming) bar so the client always has its latest
    // values without shipping the whole series.
    const from = Math.max(0, st.emitted - 1);
    ctx.postMessage({
      type: 'bars',
      tf,
      startIndex: from,
      bars: st.bars.slice(from),
    });
    st.emitted = st.bars.length;
  }

  lastTime = t[t.length - 1];
  count += t.length;
  ctx.postMessage({ type: 'progress', time: lastTime, price: p[p.length - 1], count });
}

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as {
    type: string;
    t?: ArrayLike<number>;
    p?: ArrayLike<number>;
    s?: ArrayLike<number>;
    tf?: TF;
    bars?: Bar[];
    time?: number;
  };
  if (msg.type === 'append' && msg.t && msg.p) {
    append(msg.t, msg.p, msg.s ?? []);
  } else if (msg.type === 'preload' && msg.tf && msg.bars) {
    preload(msg.tf, msg.bars);
  } else if (msg.type === 'truncate' && typeof msg.time === 'number') {
    truncate(msg.time);
  } else if (msg.type === 'reset') {
    reset();
  }
};
