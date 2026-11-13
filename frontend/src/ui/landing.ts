/**
 * Setup screen ("landing"): collects one config object and hands it to the
 * replay engine. Per the build spec this page only collects and validates
 * configuration — it draws no charts, runs no replay and reads no files
 * itself. Data verification goes through the engine's /api/scan endpoint.
 */
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import type { InstrumentInfo, SessionConfig, TickFormat, TickTimezone } from '../types';

export interface LandingHandlers {
  start(cfg: SessionConfig): void;
}

interface ScanCheck {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

interface ScanResponse {
  ok: boolean;
  checks: ScanCheck[];
  available: { first: string | null; last: string | null; count: number };
}

interface Preset {
  name: string;
  cfg: SessionConfig;
}

declare global {
  interface Window {
    desktop?: {
      pickTickData?: (currentPath: string) => Promise<string | null>;
    };
  }
}

const DAY_MS = 86_400_000;

const SYMBOL_CHIPS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF',
  'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'XAUUSD', 'XAGUSD',
];

const QUICK_RANGES = [
  { id: '1w', label: '1 week', days: 7 },
  { id: '1m', label: '1 month', days: 30 },
  { id: '3m', label: '3 months', days: 90 },
  { id: '6m', label: '6 months', days: 180 },
  { id: '1y', label: '1 year', days: 365 },
] as const;

const PRELOAD_PRESETS = [5, 10, 30, 90];

const FORMATS: { id: TickFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'parquet', label: 'Parquet' },
  { id: 'bi5', label: 'Dukascopy .bi5' },
  { id: 'mt5', label: 'MT5 export' },
];

const TIMEZONES: { id: TickTimezone; label: string }[] = [
  { id: 'utc', label: 'UTC' },
  { id: 'eet', label: 'EET (UTC+2/+3)' },
  { id: 'ny17', label: 'New York 17:00' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'ZAR'] as const;
const LEVERAGES = ['1:30', '1:50', '1:100', '1:200', '1:500', '1:1000', '1:2000'] as const;

const DEFAULT_START = '2026-09-01';
const DEFAULT_END = '2026-10-31';

// ----------------------------------------------------------------- date utils

/** Parse YYYY-MM-DD as UTC midnight; null when missing or not a real date. */
function parseUTC(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
    ? t
    : null;
}

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "1 Sep 2026" for a YYYY-MM-DD string; em dash when invalid. */
function fmtDay(s: string): string {
  const t = parseUTC(s);
  if (t === null) return '—';
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function countWeekdays(fromMs: number, toMs: number): number {
  let n = 0;
  for (let t = fromMs; t <= toMs; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch { /* keep statusText */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

// ------------------------------------------------------------------ the page

export class LandingPage {
  readonly el: HTMLElement;
  private handlers: LandingHandlers;

  /** Raw component state; everything below the inputs is derived from it. */
  private s = {
    chipSymbol: 'EURUSD' as string,   // selected chip, '' when a custom symbol is typed
    customSymbol: '',                 // text input contents
    start: DEFAULT_START,
    end: DEFAULT_END,
    history: 10,
    path: '',
    pathTouched: false,
    format: 'csv' as TickFormat,
    tz: 'utc' as TickTimezone,
    balance: '10000',
    currency: 'USD' as string,
    leverage: '1:100' as string,
    sessionName: '',
  };

  private dataDir = '';
  private instruments = new Map<string, InstrumentInfo>();
  private scanChecks: ScanCheck[] | null = null;
  private scanning = false;
  private scanNote = '';             // inline guidance when a scan can't run yet
  private presets: Preset[] = [];

  // element handles
  private symbolInput!: HTMLInputElement;
  private symbolHint!: HTMLElement;
  private startInput!: HTMLInputElement;
  private endInput!: HTMLInputElement;
  private dateError!: HTMLElement;
  private histInput!: HTMLInputElement;
  private pathInput!: HTMLInputElement;
  private browseBtn!: HTMLButtonElement;
  private scanBtn!: HTMLButtonElement;
  private dataCheck!: HTMLElement;
  private balanceInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private timelineWrap!: HTMLElement;
  private timelineBar!: HTMLElement;
  private timelineLabels!: HTMLElement;
  private summaryRows!: HTMLElement;
  private checklist!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private helperLine!: HTMLElement;
  private presetRow!: HTMLElement;

  constructor(root: HTMLElement, handlers: LandingHandlers) {
    this.handlers = handlers;
    this.el = root;
    try {
      this.presets = JSON.parse(localStorage.getItem('bt.presets') ?? '[]');
    } catch { this.presets = []; }
    this.restore();
    this.build();
    this.wire();
    this.renderDerived();
  }

  // ------------------------------------------------------------- persistence

  private restore(): void {
    let saved: Partial<SessionConfig> | null = null;
    try {
      saved = JSON.parse(localStorage.getItem('bt.sessionCfg') ?? 'null');
    } catch { saved = null; }
    if (!saved) return;
    if (saved.symbol) {
      if (SYMBOL_CHIPS.includes(saved.symbol)) this.s.chipSymbol = saved.symbol;
      else { this.s.chipSymbol = ''; this.s.customSymbol = saved.symbol; }
    }
    if (saved.start) this.s.start = saved.start;
    this.s.end = saved.end ?? DEFAULT_END;
    if (saved.historyDays !== undefined) this.s.history = saved.historyDays;
    if (saved.tickPath) { this.s.path = saved.tickPath; this.s.pathTouched = true; }
    if (saved.tickFormat) this.s.format = saved.tickFormat;
    if (saved.tickTz) this.s.tz = saved.tickTz;
    if (saved.balance !== undefined) this.s.balance = String(saved.balance);
    if (saved.currency) this.s.currency = saved.currency;
    if (saved.leverage) this.s.leverage = saved.leverage;
    if (saved.name) this.s.sessionName = saved.name;
  }

  private buildConfig(): SessionConfig {
    const symbol = this.currentSymbol();
    const parsed = parseFloat(this.s.balance);
    const cfg: SessionConfig = {
      symbol,
      balance: Number.isFinite(parsed) ? Math.max(0, parsed) : 10000,
      start: this.s.start,
      end: this.s.end,
      historyDays: this.s.history,
      name: this.s.sessionName.trim() || this.autoName(),
      currency: this.s.currency,
      leverage: this.s.leverage,
      tickPath: this.s.path,
      tickFormat: this.s.format,
      tickTz: this.s.tz,
    };
    return cfg;
  }

  // -------------------------------------------------------------------- boot

  /** Called after /api/instruments resolves. */
  setSymbols(symbols: InstrumentInfo[]): void {
    this.instruments = new Map(symbols.map(i => [i.symbol, i]));
    this.renderDerived();
  }

  /** Default root for the tick-path field: the engine's own data directory. */
  setDataDir(dir: string): void {
    this.dataDir = dir;
    if (!this.s.pathTouched) {
      this.s.path = this.defaultPath();
      this.pathInput.value = this.s.path;
      this.invalidateScan();
      this.renderDerived();
    }
  }

  private defaultPath(): string {
    const sym = this.currentSymbol();
    return this.dataDir ? `${this.dataDir}/ticks/${sym}` : '';
  }

  // -------------------------------------------------------------- derived bits

  private currentSymbol(): string {
    return this.s.customSymbol.trim() || this.s.chipSymbol;
  }

  private startMs(): number | null { return parseUTC(this.s.start); }
  private endMs(): number | null { return parseUTC(this.s.end); }

  private datesValid(): boolean {
    return this.startMs() !== null && this.endMs() !== null && this.endMs()! > this.startMs()!;
  }

  private spanDays(): number {
    const a = this.startMs();
    const b = this.endMs();
    if (a === null || b === null || b <= a) return 0;
    return Math.round((b - a) / DAY_MS) + 1;
  }

  private preloadStart(): string | null {
    const a = this.startMs();
    if (a === null) return null;
    return dayString(a - this.s.history * DAY_MS);
  }

  private autoName(): string {
    return `${this.currentSymbol() || '—'} · ${fmtDay(this.s.start)} – ${fmtDay(this.s.end)}`;
  }

  /** The four readiness items of the "Ready to start" checklist. */
  private checklistItems(): { label: string; done: boolean }[] {
    const scannedOk = this.scanChecks !== null && this.scanChecks.every(c => c.ok);
    return [
      { label: 'Symbol selected', done: this.currentSymbol().length > 0 },
      { label: 'Valid date range', done: this.datesValid() },
      { label: 'Tick data path set', done: this.s.path.trim().length > 0 },
      { label: 'Tick data scanned and verified', done: scannedOk },
    ];
  }

  // -------------------------------------------------------------------- markup

  private chipRow(id: string, items: { id: string; label: string }[]): string {
    return items.map(it =>
      `<button type="button" class="sp-chip" data-group="${id}" data-id="${it.id}" aria-pressed="false">${it.label}</button>`
    ).join('');
  }

  private build(): void {
    this.el.innerHTML = `
      <div class="sp-page">
        <header class="sp-header">
          <div class="sp-brand">
            <svg class="sp-logo" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <rect x="4" y="8" width="3" height="11" rx="1" fill="#2DD4BF"/>
              <rect x="5.5" y="4" width="1" height="18" fill="#2DD4BF"/>
              <rect x="14" y="5" width="3" height="9" rx="1" fill="#5EEAD4" opacity=".55"/>
              <rect x="15.5" y="2" width="1" height="16" fill="#5EEAD4" opacity=".55"/>
              <rect x="19" y="12" width="3" height="8" rx="1" fill="#2DD4BF"/>
              <rect x="20.5" y="10" width="1" height="12" fill="#2DD4BF"/>
            </svg>
            <span class="sp-name">Forex Backtester</span>
          </div>
          <div class="sp-steps" aria-label="Progress">
            <span class="sp-step active"><i>1</i>Setup</span>
            <span class="sp-step"><i>2</i>Replay</span>
          </div>
        </header>

        <main class="sp-body">
          <div class="sp-title">
            <h1>New backtest session</h1>
            <p>Choose what to replay and how the engine should start.</p>
          </div>

          <div class="sp-columns">
            <aside class="sp-panel" id="sp-panel">
              <h2>Session summary</h2>
              <div class="sp-field">
                <label for="sp-name">Session name</label>
                <input id="sp-name" type="text" spellcheck="false" autocomplete="off" />
              </div>
              <div class="sp-summary" id="sp-summary"></div>
              <h3>Ready to start</h3>
              <ul class="sp-checklist" id="sp-checklist"></ul>
              <button id="sp-start" class="sp-start" disabled>
                <span>Start replay</span>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2 8h10M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.8"
                    fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <p class="sp-helper" id="sp-helper"></p>
              <button id="sp-save-preset" class="sp-secondary">Save as preset</button>
              <div class="sp-preset-row" id="sp-preset-row"></div>
            </aside>

            <form class="sp-form" id="sp-form" novalidate>
              <section class="sp-card">
                <header class="sp-card-head"><span class="sp-num">01</span><h2>Market and period</h2></header>

                <div class="sp-field">
                  <span class="sp-label" id="sp-sym-label">Symbol</span>
                  <div class="sp-chips" id="sp-sym-chips" role="group" aria-labelledby="sp-sym-label">
                    ${this.chipRow('sym', SYMBOL_CHIPS.map(s => ({ id: s, label: s })))}
                  </div>
                  <p class="sp-symbol-hint" id="sp-symbol-hint"></p>
                  <label class="sp-sublabel" for="sp-symbol-input">Or type another symbol</label>
                  <input id="sp-symbol-input" type="text" spellcheck="false" autocomplete="off"
                    placeholder="e.g. GER40" />
                </div>

                <div class="sp-row">
                  <div class="sp-field">
                    <label for="sp-start">Start date</label>
                    <input id="sp-start" type="date" value="${this.s.start}" />
                  </div>
                  <div class="sp-field">
                    <label for="sp-end">End date</label>
                    <input id="sp-end" type="date" value="${this.s.end}" />
                  </div>
                </div>
                <div class="sp-field-error" id="sp-date-error" role="alert"></div>

                <div class="sp-field">
                  <span class="sp-label" id="sp-qr-label">Quick range</span>
                  <div class="sp-chips" id="sp-qr-chips" role="group" aria-labelledby="sp-qr-label">
                    ${this.chipRow('qr', QUICK_RANGES.map(r => ({ id: r.id, label: r.label })))}
                  </div>
                </div>

                <div class="sp-field">
                  <span class="sp-label" id="sp-hist-label">Preload history</span>
                  <div class="sp-stepper">
                    <button type="button" id="sp-hist-minus" aria-label="Decrease preload days">−</button>
                    <input id="sp-hist" type="text" inputmode="numeric" value="${this.s.history}"
                      aria-labelledby="sp-hist-label" />
                    <button type="button" id="sp-hist-plus" aria-label="Increase preload days">+</button>
                  </div>
                  <div class="sp-chips" id="sp-hist-chips" role="group" aria-labelledby="sp-hist-label">
                    ${this.chipRow('hist', PRELOAD_PRESETS.map(d => ({ id: String(d), label: `${d}d` })))}
                  </div>
                  <p class="sp-hint">How many days of candles are already on the chart before the replay begins.</p>
                </div>

                <div class="sp-field">
                  <span class="sp-label">Timeline preview</span>
                  <div class="sp-timeline" id="sp-timeline">
                    <div class="sp-timeline-bar" id="sp-timeline-bar"></div>
                    <div class="sp-timeline-labels" id="sp-timeline-labels"></div>
                  </div>
                </div>
              </section>

              <section class="sp-card">
                <header class="sp-card-head"><span class="sp-num">02</span><h2>Tick data</h2></header>

                <div class="sp-field">
                  <label for="sp-path">Path to tick data</label>
                  <div class="sp-path-row">
                    <input id="sp-path" type="text" class="sp-mono" spellcheck="false" autocomplete="off" />
                    <button type="button" id="sp-browse" class="sp-action" aria-label="Browse for tick data folder or file">Browse</button>
                    <button type="button" id="sp-scan" class="sp-action">Scan data</button>
                  </div>
                  <p class="sp-hint">A folder or a single file with ticks for the selected symbol. Expected
                    columns: timestamp, bid, ask and optionally volume.</p>
                </div>

                <div class="sp-field">
                  <span class="sp-label" id="sp-fmt-label">File format</span>
                  <div class="sp-chips" id="sp-fmt-chips" role="group" aria-labelledby="sp-fmt-label">
                    ${this.chipRow('fmt', FORMATS)}
                  </div>
                </div>

                <div class="sp-field">
                  <span class="sp-label" id="sp-tz-label">Timestamps are in</span>
                  <div class="sp-chips" id="sp-tz-chips" role="group" aria-labelledby="sp-tz-label">
                    ${this.chipRow('tz', TIMEZONES)}
                  </div>
                  <p class="sp-hint">A wrong timezone shifts every candle, so it is required.</p>
                </div>

                <div class="sp-datacheck" id="sp-datacheck" aria-live="polite"></div>
              </section>

              <section class="sp-card">
                <header class="sp-card-head"><span class="sp-num">03</span><h2>Account</h2></header>

                <div class="sp-row">
                  <div class="sp-field">
                    <label for="sp-balance">Starting balance</label>
                    <input id="sp-balance" type="text" inputmode="decimal" class="sp-mono"
                      value="${this.s.balance}" autocomplete="off" />
                  </div>
                </div>

                <div class="sp-field">
                  <span class="sp-label" id="sp-cur-label">Account currency</span>
                  <div class="sp-chips" id="sp-cur-chips" role="group" aria-labelledby="sp-cur-label">
                    ${this.chipRow('cur', CURRENCIES.map(c => ({ id: c, label: c })))}
                  </div>
                </div>

                <div class="sp-field">
                  <span class="sp-label" id="sp-lev-label">Leverage</span>
                  <div class="sp-chips" id="sp-lev-chips" role="group" aria-labelledby="sp-lev-label">
                    ${this.chipRow('lev', LEVERAGES.map(l => ({ id: l, label: l })))}
                  </div>
                </div>
              </section>
            </form>
          </div>
        </main>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    this.symbolInput = q('#sp-symbol-input');
    this.symbolHint = q('#sp-symbol-hint');
    this.startInput = q('#sp-start');
    this.endInput = q('#sp-end');
    this.dateError = q('#sp-date-error');
    this.histInput = q('#sp-hist');
    this.pathInput = q('#sp-path');
    this.browseBtn = q('#sp-browse');
    this.scanBtn = q('#sp-scan');
    this.dataCheck = q('#sp-datacheck');
    this.balanceInput = q('#sp-balance');
    this.nameInput = q('#sp-name');
    this.timelineWrap = q('#sp-timeline');
    this.timelineBar = q('#sp-timeline-bar');
    this.timelineLabels = q('#sp-timeline-labels');
    this.summaryRows = q('#sp-summary');
    this.checklist = q('#sp-checklist');
    this.startBtn = q('#sp-start') as HTMLButtonElement;
    this.helperLine = q('#sp-helper');
    this.presetRow = q('#sp-preset-row');

    // hydrate inputs from restored state
    this.symbolInput.value = this.s.customSymbol;
    this.pathInput.value = this.s.path;
    this.nameInput.placeholder = this.autoName();

    if (!window.desktop?.pickTickData) {
      this.browseBtn.disabled = true;
      this.browseBtn.title = 'Native folder picker is available in the desktop app';
    }
  }

  // -------------------------------------------------------------------- wiring

  private wire(): void {
    // symbol chips + custom input
    this.el.querySelector('#sp-sym-chips')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.sp-chip');
      if (!btn) return;
      this.s.chipSymbol = btn.dataset.id!;
      this.s.customSymbol = '';
      this.symbolInput.value = '';
      if (!this.s.pathTouched) {
        this.s.path = this.defaultPath();
        this.pathInput.value = this.s.path;
      }
      this.invalidateScan();
      this.renderDerived();
    });
    this.symbolInput.addEventListener('input', () => {
      // Force upper case, strip everything except A–Z, 0–9, "." and "_".
      const clean = this.symbolInput.value.toUpperCase().replace(/[^A-Z0-9._]/g, '');
      this.symbolInput.value = clean;
      this.s.customSymbol = clean;
      this.s.chipSymbol = '';
      if (!this.s.pathTouched) {
        this.s.path = this.defaultPath();
        this.pathInput.value = this.s.path;
      }
      this.invalidateScan();
      this.renderDerived();
    });

    // dates
    for (const input of [this.startInput, this.endInput]) {
      input.addEventListener('input', () => {
        this.s.start = this.startInput.value;
        this.s.end = this.endInput.value;
        this.invalidateScan();
        this.renderDerived();
      });
    }

    // quick range chips — change the start date only; the end date anchors
    this.el.querySelector('#sp-qr-chips')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.sp-chip');
      if (!btn) return;
      const range = QUICK_RANGES.find(r => r.id === btn.dataset.id);
      const endMs = this.endMs();
      if (!range || endMs === null) return;
      this.s.start = dayString(endMs - (range.days - 1) * DAY_MS);
      this.startInput.value = this.s.start;
      this.invalidateScan();
      this.renderDerived();
    });

    // preload stepper + presets
    const setHistory = (n: number) => {
      const clamped = Math.min(365, Math.max(0, n));
      this.s.history = clamped;
      this.histInput.value = String(clamped);
      this.invalidateScan();
      this.renderDerived();
    };
    q2(this.el, '#sp-hist-minus').addEventListener('click', () => setHistory(this.s.history - 1));
    q2(this.el, '#sp-hist-plus').addEventListener('click', () => setHistory(this.s.history + 1));
    this.histInput.addEventListener('input', () => {
      const n = parseInt(this.histInput.value, 10);
      setHistory(Number.isNaN(n) ? 0 : n);
    });
    this.el.querySelector('#sp-hist-chips')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.sp-chip');
      if (!btn) return;
      setHistory(parseInt(btn.dataset.id!, 10));
    });

    // tick path + browse + scan
    this.pathInput.addEventListener('input', () => {
      this.s.path = this.pathInput.value;
      this.s.pathTouched = true;
      this.invalidateScan();
      this.renderDerived();
    });
    this.browseBtn.addEventListener('click', async () => {
      const picked = await window.desktop?.pickTickData?.(this.s.path);
      if (picked) {
        this.s.path = picked;
        this.s.pathTouched = true;
        this.pathInput.value = picked;
        this.invalidateScan();
        this.renderDerived();
      }
    });
    this.scanBtn.addEventListener('click', () => void this.runScan());

    // format / timezone / currency / leverage chips (generic selector)
    for (const [sel, key] of [
      ['#sp-fmt-chips', 'format'],
      ['#sp-tz-chips', 'tz'],
      ['#sp-cur-chips', 'currency'],
      ['#sp-lev-chips', 'leverage'],
    ] as const) {
      this.el.querySelector(sel)!.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.sp-chip');
        if (!btn) return;
        (this.s as Record<string, unknown>)[key] = btn.dataset.id;
        if (key !== 'currency' && key !== 'leverage') this.invalidateScan();
        this.renderDerived();
      });
    }

    // summary panel
    this.nameInput.addEventListener('input', () => { this.s.sessionName = this.nameInput.value; });
    this.balanceInput.addEventListener('input', () => {
      this.s.balance = this.balanceInput.value;
      this.renderDerived();
    });

    this.startBtn.addEventListener('click', () => {
      if (!this.startBtn.disabled) this.submit();
    });
    this.el.querySelector('#sp-save-preset')!.addEventListener('click', () => this.savePreset());
    this.presetRow.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.sp-chip');
      if (!btn) return;
      const preset = this.presets[Number(btn.dataset.index)];
      if (preset) this.loadPreset(preset);
    });

    // The form must not navigate on Enter inside inputs.
    q2(this.el, '#sp-form').addEventListener('submit', (e) => e.preventDefault());
  }

  private invalidateScan(): void {
    this.scanChecks = null;
    this.scanNote = '';
    this.scanning = false;
  }

  // ------------------------------------------------------------------- scanning

  private async runScan(): Promise<void> {
    const symbol = this.currentSymbol();
    if (!symbol || !this.datesValid()) {
      this.scanChecks = null;
      this.scanNote = 'Enter a symbol and a valid date range before scanning.';
      this.renderDerived();
      return;
    }
    const path = this.s.path.trim();
    if (!path) {
      this.scanChecks = null;
      this.scanNote = 'Set the tick data path first, then scan.';
      this.renderDerived();
      return;
    }

    this.scanning = true;
    this.scanChecks = null;
    this.scanNote = '';
    this.renderDerived();

    const params = new URLSearchParams({
      symbol,
      start: this.s.start,
      end: this.s.end,
      historyDays: String(this.s.history),
      path,
    });
    try {
      const res = await getJSON<ScanResponse>(`/api/scan?${params.toString()}`);
      this.scanChecks = res.checks;
      // Constrain the date pickers to what the store actually has.
      if (res.available.first) this.startInput.min = res.available.first;
      if (res.available.last) {
        this.startInput.max = res.available.last;
        this.endInput.max = res.available.last;
      }
    } catch (err) {
      this.scanChecks = [{
        id: 'engine', ok: false, label: 'Engine reachable',
        detail: err instanceof Error ? err.message : 'The replay engine did not answer.',
      }];
    }
    this.scanning = false;
    this.renderDerived();
  }

  // -------------------------------------------------------------------- presets

  private savePreset(): void {
    const cfg = this.buildConfig();
    const name = cfg.name ?? this.autoName();
    this.presets = this.presets.filter(p => p.name !== name);
    this.presets.unshift({ name, cfg });
    this.presets = this.presets.slice(0, 12);
    localStorage.setItem('bt.presets', JSON.stringify(this.presets));
    this.renderDerived();
  }

  private loadPreset(preset: Preset): void {
    const cfg = preset.cfg;
    if (SYMBOL_CHIPS.includes(cfg.symbol)) { this.s.chipSymbol = cfg.symbol; this.s.customSymbol = ''; }
    else { this.s.chipSymbol = ''; this.s.customSymbol = cfg.symbol; }
    this.symbolInput.value = this.s.customSymbol;
    this.s.start = cfg.start;
    this.s.end = cfg.end ?? DEFAULT_END;
    this.startInput.value = this.s.start;
    this.endInput.value = this.s.end;
    if (cfg.historyDays !== undefined) this.s.history = cfg.historyDays;
    this.histInput.value = String(this.s.history);
    if (cfg.tickPath) { this.s.path = cfg.tickPath; this.s.pathTouched = true; this.pathInput.value = cfg.tickPath; }
    if (cfg.tickFormat) this.s.format = cfg.tickFormat;
    if (cfg.tickTz) this.s.tz = cfg.tickTz;
    if (cfg.balance !== undefined) { this.s.balance = String(cfg.balance); this.balanceInput.value = this.s.balance; }
    if (cfg.currency) this.s.currency = cfg.currency;
    if (cfg.leverage) this.s.leverage = cfg.leverage;
    this.s.sessionName = preset.name;
    this.nameInput.value = preset.name;
    this.invalidateScan();
    this.renderDerived();
  }

  // ----------------------------------------------------------------- rendering

  /**
   * Re-render everything derived from state. Input element values are NOT
   * rewritten here (they belong to the user while focused); programmatic
   * changes write both state and DOM at the call site.
   */
  private renderDerived(): void {
    const symbol = this.currentSymbol();

    // chip pressed states
    const setPressed = (group: string, activeId: string | null) => {
      for (const btn of this.el.querySelectorAll<HTMLButtonElement>(`.sp-chip[data-group="${group}"]`)) {
        const on = activeId !== null && btn.dataset.id === activeId;
        btn.setAttribute('aria-pressed', String(on));
      }
    };
    setPressed('sym', this.s.customSymbol ? null : this.s.chipSymbol);
    setPressed('qr', this.matchingQuickRange());
    setPressed('hist', PRELOAD_PRESETS.includes(this.s.history) ? String(this.s.history) : null);
    setPressed('fmt', this.s.format);
    setPressed('tz', this.s.tz);
    setPressed('cur', this.s.currency);
    setPressed('lev', this.s.leverage);

    // instrument hint under the symbol chips
    const info = this.instruments.get(symbol);
    this.symbolHint.textContent = info ? info.name : '';

    // date error (role=alert)
    const startT = this.startMs();
    const endT = this.endMs();
    let dateMsg = '';
    if (startT === null || endT === null) dateMsg = 'Enter a valid start and end date.';
    else if (endT <= startT) dateMsg = 'The end date must be after the start date.';
    this.dateError.textContent = dateMsg;
    this.dateError.classList.toggle('visible', !!dateMsg);

    // timeline preview
    this.renderTimeline(startT, endT);

    // data check box
    this.renderDataCheck();

    // summary rows
    this.renderSummary(symbol, startT, endT);

    // checklist + button + helper
    const items = this.checklistItems();
    this.checklist.innerHTML = items.map(it => `
      <li class="${it.done ? 'done' : ''}">
        <span class="sp-dot" aria-hidden="true">${it.done ? '✓' : ''}</span>
        <span>${it.label}<span class="sp-sr"> (${it.done ? 'done' : 'not done'})</span></span>
      </li>`).join('');

    const ready = items.every(it => it.done);
    this.startBtn.disabled = !ready;
    this.helperLine.textContent = ready
      ? (this.s.history > 0
        ? `Opens the replay with ${this.s.history} days of history before ${fmtDay(this.s.start)}.`
        : `Opens the replay from ${fmtDay(this.s.start)}.`)
      : 'Finish the checklist above to start the replay.';

    // session name placeholder tracks the auto name
    this.nameInput.placeholder = this.autoName();

    // presets
    this.presetRow.innerHTML = this.presets.length
      ? `<span class="sp-sublabel">Presets</span><div class="sp-chips">${
        this.presets.map((p, i) =>
          `<button type="button" class="sp-chip sp-chip-sm" data-index="${i}"
            title="${escapeHtml(p.name)}">${escapeHtml(shortName(p.name))}</button>`).join('')
      }</div>`
      : '';
  }

  private matchingQuickRange(): string | null {
    const span = this.spanDays();
    const hit = QUICK_RANGES.find(r => r.days === span);
    return hit ? hit.id : null;
  }

  private renderTimeline(startT: number | null, endT: number | null): void {
    const valid = startT !== null && endT !== null && endT > startT;
    if (!valid) {
      this.timelineWrap.classList.add('empty');
      this.timelineBar.innerHTML = '';
      this.timelineLabels.innerHTML = '';
      return;
    }
    this.timelineWrap.classList.remove('empty');
    const hist = this.s.history;
    const span = this.spanDays();
    const total = Math.max(1, hist + span);
    const histPct = (hist / total) * 100;
    this.timelineBar.innerHTML = `
      <div class="seg hist" style="width:${histPct}%"><span>${hist} d history</span></div>
      <div class="seg replay" style="width:${100 - histPct}%"><span>${span} d replay</span></div>`;
    const pre = this.preloadStart();
    this.timelineLabels.innerHTML = `
      <span title="Preload start">${fmtDay(pre ?? this.s.start)}</span>
      <span title="Replay start">${fmtDay(this.s.start)}</span>
      <span title="Replay end">${fmtDay(this.s.end)}</span>`;
  }

  private renderDataCheck(): void {
    if (this.scanning) {
      this.dataCheck.innerHTML = `<p class="sp-check-note">Scanning the tick store…</p>`;
      this.scanBtn.disabled = true;
      return;
    }
    this.scanBtn.disabled = false;
    if (this.scanNote) {
      this.dataCheck.innerHTML = `<p class="sp-check-note">${escapeHtml(this.scanNote)}</p>`;
      return;
    }
    if (!this.scanChecks) {
      this.dataCheck.innerHTML = `<p class="sp-check-note">Run a scan to confirm the files cover your dates
        and preload window.</p>`;
      return;
    }
    this.dataCheck.innerHTML = `<ul>${this.scanChecks.map(c => `
      <li class="${c.ok ? 'ok' : 'fail'}">
        <span class="sp-dot" aria-hidden="true">${c.ok ? '✓' : '✕'}</span>
        <span><strong>${escapeHtml(c.label)}</strong>${c.detail ? ` — ${escapeHtml(c.detail)}` : ''}</span>
      </li>`).join('')}</ul>`;
  }

  private renderSummary(symbol: string, startT: number | null, endT: number | null): void {
    const validRange = startT !== null && endT !== null && endT > startT;
    const span = this.spanDays();
    const weekdays = validRange ? countWeekdays(startT!, endT!) : 0;
    const pre = this.preloadStart();
    const fmtLabel = FORMATS.find(f => f.id === this.s.format)?.label ?? this.s.format;
    const tzLabel = TIMEZONES.find(t => t.id === this.s.tz)?.label ?? this.s.tz;
    const balance = fmtNumber(parseFloat(this.s.balance) || 0);

    const row = (label: string, value: string, title?: string) => `
      <div class="sp-row-line">
        <span class="k">${label}</span>
        <span class="v"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(value)}</span>
      </div>`;

    this.summaryRows.innerHTML = [
      row('Symbol', symbol || '—'),
      row('Replay period', validRange ? `${fmtDay(this.s.start)} → ${fmtDay(this.s.end)}` : '—'),
      row('Trading days', validRange ? `${weekdays} (${span} days)` : '—'),
      row('History preload', this.s.history > 0 ? `${this.s.history} days, from ${fmtDay(pre ?? '')}` : '0 days'),
      row('Tick source', this.s.path || '—', this.s.path || undefined),
      row('Format and time', `${fmtLabel} · ${tzLabel}`),
      row('Account', `${balance} ${this.s.currency} · ${this.s.leverage}`),
    ].join('');
  }

  // -------------------------------------------------------------------- submit

  private submit(): void {
    const cfg = this.buildConfig();
    localStorage.setItem('bt.sessionCfg', JSON.stringify(cfg));
    this.handlers.start(cfg);
  }

  show(): void {
    this.el.classList.remove('hidden');
    this.renderDerived();
  }

  hide(): void {
    this.el.classList.add('hidden');
  }
}

// ----------------------------------------------------------------- tiny utils

function q2(root: HTMLElement, sel: string): HTMLElement {
  return root.querySelector(sel) as HTMLElement;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** Preset chips stay small: drop the long date range part. */
function shortName(name: string): string {
  return name.length <= 24 ? name : `${name.slice(0, 21)}…`;
}
