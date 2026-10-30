const priceFormatters = new Map<number, Intl.NumberFormat>();

export function fmtPrice(price: number, digits: number): string {
  let fmt = priceFormatters.get(digits);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: true,
    });
    priceFormatters.set(digits, fmt);
  }
  return fmt.format(price);
}

/** Compact price for axis labels: show only the decimals the grid step needs. */
export function fmtPriceAxis(price: number, digits: number, step: number): string {
  const decimals = Math.max(0, Math.min(digits, decimalsForStep(step)));
  let fmt = priceFormatters.get(decimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: true,
    });
    priceFormatters.set(decimals, fmt);
  }
  return fmt.format(price);
}

function decimalsForStep(step: number): number {
  if (!isFinite(step) || step <= 0) return 0;
  const text = step.toFixed(12).replace(/0+$/, '');
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

const timeFmt: Record<string, Intl.DateTimeFormat> = {
  sec: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }),
  min: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }),
  hour: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }),
  day: new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
  month: new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
  full: new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'UTC',
  }),
};

export function fmtTime(ms: number, stepMs = 60_000): string {
  const d = new Date(ms);
  if (stepMs < 60_000) return timeFmt.sec.format(d);
  if (stepMs < 86_400_000) return timeFmt.hour.format(d);
  if (stepMs < 32 * 86_400_000) return timeFmt.day.format(d);
  return timeFmt.month.format(d);
}

export function fmtClock(ms: number): string {
  return timeFmt.full.format(new Date(ms)) + ' UTC';
}

/** 1/2/2.5/5 x 10^n step that yields roughly `target` gridlines. */
export function niceStep(range: number, target: number): number {
  if (!isFinite(range) || range <= 0) return 1;
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Index of the first bar with t >= time (0 if none). */
export function lowerBound(bars: { t: number }[], time: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}
