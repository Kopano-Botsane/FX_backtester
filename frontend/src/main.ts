import './styles.css';
import { ChartPane, type ChartHost } from './chart/pane';
import { MarketData } from './data/market';
import { ReplayClient, type SessionInfo } from './data/replay';
import { Store, loadDrawings, saveDrawings } from './store';
import { SyncChannel } from './sync';
import { TradePanel } from './ui/trade';
import { LandingPage } from './ui/landing';
import {
  TF_LIST,
  TF_MS,
  EMPTY_PORTFOLIO,
  type AppState,
  type Bar,
  type Drawing,
  type DrawingKind,
  type EquityPoint,
  type InstrumentInfo,
  type PaneState,
  type Point,
  type SessionConfig,
  type TF,
  type Tool,
} from './types';
import { Toolbar } from './ui/toolbar';
import { clamp, fmtClock, isTypingTarget, uid } from './util';

interface InstrumentMeta {
  instruments: InstrumentInfo[];
  speeds: number[];
  timeframes: string[];
  dataDir?: string;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      message = body.detail ?? body.error ?? message;
    } catch {
      /* non-json error */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function makePaneState(tf: TF, seed?: PaneState): PaneState {
  return {
    id: uid(),
    tf,
    priceMin: seed?.priceMin ?? 0,
    priceMax: seed?.priceMax ?? 1,
    rightTime: seed?.rightTime ?? 0,
    pxPerMs: seed?.pxPerMs ?? 0,
    plotWidth: seed?.plotWidth ?? 600,
    follow: seed?.follow ?? true,
    autoScale: true,
    viewReady: seed?.viewReady ?? false,
  };
}

class App implements ChartHost {
  readonly store: Store;
  readonly market = new MarketData();
  readonly replay = new ReplayClient();
  readonly sync = new SyncChannel();

  instruments: InstrumentInfo[] = [];
  speeds: number[] = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

  private panes = new Map<string, ChartPane>();
  private grid = document.getElementById('grid')!;
  private toolbar!: Toolbar;
  private tradePanel!: TradePanel;
  private landingPage!: LandingPage;
  private clockEl!: HTMLElement;
  private scrubber!: HTMLInputElement;
  private hintEl!: HTMLElement;
  private undoStack: Drawing[][] = [];
  private persistTimer = 0;
  private viewTimer = 0;
  private applyingRemote = false;
  private scrubbing = false;
  private sessionToken = 0;

  constructor() {
    this.store = new Store({
      symbol: '',
      digits: 5,
      day: '',
      panes: [],
      tool: 'cursor',
      color: '#4c8dff',
      drawings: [],
      selectedId: null,
      crosshair: null,
      syncTime: true,
      syncDrawings: true,
      sessionKey: 0,
      portfolio: { ...EMPTY_PORTFOLIO },
      trade: { open: localStorage.getItem('bt.trade') !== '0', equity: [] },
      replay: {
        status: 'idle',
        speed: 10,
        time: 0,
        sessionStart: 0,
        sessionEnd: 0,
        tickCount: 0,
      },
    });
    this.store.subscribe(() => this.updateStatus());
    this.market.subscribe(() => this.onMarketUpdate());
  }

  // ------------------------------------------------------------------ bootstrap

  async boot(): Promise<void> {
    const meta = await getJSON<InstrumentMeta>('/api/instruments');
    this.instruments = meta.instruments;
    this.speeds = meta.speeds;

    const savedSpeed = Number(localStorage.getItem('bt.speed') ?? '');
    if (this.speeds.includes(savedSpeed)) this.store.state.replay.speed = savedSpeed;

    this.buildLandingPage(meta);
    this.buildToolbar();
    this.buildStatusBar();
    this.buildTradePanel();
    this.addPane('5m');
    this.addPane('1m');
    this.wireReplay();
    this.wireSync();
    this.wireKeyboard();
  }

  private buildLandingPage(meta: InstrumentMeta): void {
    const root = document.getElementById('landing')!;
    this.landingPage = new LandingPage(root, {
      start: (cfg) => this.startSession(cfg),
    });
    this.landingPage.setSymbols(meta.instruments);
    if (meta.dataDir) this.landingPage.setDataDir(meta.dataDir);
    this.landingPage.show();
  }

  private buildToolbar(): void {
    this.toolbar = new Toolbar(document.getElementById('toolbar')!, {
      onSpeed: (speed) => this.setSpeed(speed),
      onPauseToggle: () => this.togglePause(),
      onRestart: () => this.restartSession(),
      onLayout: (count) => this.setLayout(count),
      onTool: (tool: Tool) => this.store.update({ tool, selectedId: null }),
      onColor: (color) => this.store.update({ color }),
      onSyncTime: () => this.toggleSyncTime(),
      onUndo: () => this.undo(),
      onClearDrawings: () => this.clearDrawings(),
      onLatest: () => this.latest(),
      onTrade: () => this.toggleTradePanel(),
      onExit: () => this.exitToLanding(),
    });
  }

  private buildTradePanel(): void {
    const aside = document.getElementById('trade')!;
    this.tradePanel = new TradePanel(aside, {
      place: (side) => this.placeTicket(side),
      cancel: (id) => this.replay.cancelOrder(id),
      flatten: () => this.replay.flatten(),
      clearSltp: () => this.replay.setSltp(null, null),
      reset: () => this.replay.resetBook(),
      togglePanel: () => this.toggleTradePanel(),
    });
    this.applyTradePanelVisibility();
  }

  private toggleTradePanel(): void {
    this.store.state.trade.open = !this.store.state.trade.open;
    localStorage.setItem('bt.trade', this.store.state.trade.open ? '1' : '0');
    this.applyTradePanelVisibility();
    this.store.emit();
  }

  private applyTradePanelVisibility(): void {
    document.getElementById('app')!.classList.toggle('trade-hidden', !this.store.state.trade.open);
  }

  private placeTicket(side: 'buy' | 'sell'): void {
    if (!this.tradePanel) return;
    const t = this.tradePanel.ticket();
    if (!(t.size > 0)) {
      this.tradePanel.setNote('Size must be a positive number');
      return;
    }
    if (t.kind !== 'market' && !t.price) {
      this.tradePanel.setNote('Limit/stop orders need a trigger price');
      return;
    }
    this.tradePanel.setSide(side);
    this.replay.placeOrder(t.kind, side, t.size, t.price, t.sl ?? null, t.tp ?? null);
  }

  private buildStatusBar(): void {
    const bar = document.getElementById('statusbar')!;
    bar.innerHTML = `
      <span class="clock">--:--:--</span>
      <div class="scrub">
        <input type="range" min="0" max="1000" value="0" title="Scrub the session" />
      </div>
      <span class="hint"></span>
    `;
    this.clockEl = bar.querySelector('.clock')!;
    this.scrubber = bar.querySelector('input')!;
    this.hintEl = bar.querySelector('.hint')!;

    this.scrubber.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.scrubber.addEventListener('pointerup', () => (this.scrubbing = false));
    this.scrubber.addEventListener('change', () => {
      const { sessionStart, sessionEnd } = this.store.state.replay;
      const pct = Number(this.scrubber.value) / 1000;
      this.seek(sessionStart + pct * (sessionEnd - sessionStart));
    });
  }

  private wireReplay(): void {
    this.replay.on('session', (s: SessionInfo) => {
      this.store.state.replay.sessionStart = s.start;
      this.store.state.replay.sessionEnd = s.end;
      this.store.state.replay.time = s.time;
      this.store.state.replay.tickCount = s.tickCount;
      this.store.state.digits = s.digits;
      this.store.emit();
    });
    this.replay.on('reset', () => {
      // The server sends 'reset' on session start and on seek, right before
      // re-sending history chunks. The market must NOT be wiped here: seeded
      // prehistory bars must survive session start, and seeks truncate via
      // market.truncateTo() before the WS seek command is sent.
      this.store.state.portfolio = { ...EMPTY_PORTFOLIO };
      this.store.state.trade.equity = [];
      this.store.state.replay.status = 'loading';
      this.store.emit();
    });
    this.replay.on('history', (t, p, s) => this.market.append(t, p, s));
    this.replay.on('ticks', (t, p, s) => {
      this.market.append(t, p, s);
      this.pushEquity(t[t.length - 1], p[p.length - 1]);
      if (this.store.state.replay.status === 'loading') {
        this.store.state.replay.status = 'playing';
        this.store.emit();
      }
    });
    this.replay.on('portfolio', (p) => {
      this.store.state.portfolio = p;
      this.store.emit();
    });
    this.replay.on('state', (s) => {
      const r = this.store.state.replay;
      r.time = s.time;
      r.speed = s.speed;
      r.status = s.ended ? 'ended' : s.paused ? 'paused' : 'playing';
      this.store.emit();
    });
    this.replay.on('error', (message) => {
      this.store.state.replay.status = 'error';
      this.store.state.replay.message = message;
      this.store.emit();
    });
    this.replay.on('close', () => {
      const status = this.store.state.replay.status;
      if (status === 'ended' || status === 'error') return;
      this.store.state.replay.status = 'error';
      this.store.state.replay.message = 'replay connection lost';
      this.store.emit();
    });
  }

  private wireSync(): void {
    this.sync.onDrawings = (symbol, drawings) => {
      if (symbol !== this.store.state.symbol) return;
      this.applyingRemote = true;
      this.store.update({ drawings, selectedId: null });
      this.applyingRemote = false;
      saveDrawings(symbol, drawings);
    };
    this.sync.onView = (rightTime, pxPerMs) => {
      if (!this.store.state.syncTime) return;
      const source = this.store.state.panes[0];
      if (!source) return;
      this.applyingRemote = true;
      this.store.setView(source.id, rightTime, pxPerMs);
      this.applyingRemote = false;
    };
    this.sync.onCrosshair = (c) => {
      this.applyingRemote = true;
      this.store.update({ crosshair: c });
      this.applyingRemote = false;
    };
  }

  private wireKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      const state = this.store.state;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undo();
        return;
      }
      if (e.key === 'Escape') {
        this.store.update({ tool: 'cursor', selectedId: null });
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedId) {
          e.preventDefault();
          this.removeDrawing(state.selectedId);
        }
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        this.togglePause();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.shiftKey ? 300 : 30) * 1000;
        this.seek(state.replay.time + (e.key === 'ArrowLeft' ? -step : step));
        return;
      }
      if (e.key === '+' || e.key === '=') {
        this.cycleSpeed(1);
        return;
      }
      if (e.key === '-') {
        this.cycleSpeed(-1);
        return;
      }
      if (/^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        this.setLayout(Number(e.key));
        return;
      }
      const k = e.key.toLowerCase();
      if ((k === 'b' || k === 's') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.placeTicket(k === 'b' ? 'buy' : 'sell');
      }
    });
  }

  // -------------------------------------------------------------------- session

  private async startSession(cfg: SessionConfig): Promise<void> {
    // Call /api/session to resolve the day list and session bounds
    const params = new URLSearchParams({
      symbol: cfg.symbol,
      start: cfg.start,
      historyDays: String(cfg.historyDays),
    });
    if (cfg.end) params.set('end', cfg.end);
    const info = await getJSON<SessionInfo>(`/api/session?${params.toString()}`);

    // Fetch prehistory bars for every timeframe in one batch request, so any
    // pane — or a pane the user switches to another timeframe later — has
    // history before the replay start without a tick-level history load.
    const panes = this.store.state.panes;
    const barsParams = new URLSearchParams({
      symbol: cfg.symbol,
      start: cfg.start,
      historyDays: String(cfg.historyDays),
      tfs: TF_LIST.join(','),
    });
    if (cfg.end) barsParams.set('end', cfg.end);
    const preBarsByTf = new Map<TF, Bar[]>();
    let replayDaysList: string[] = [];
    try {
      const barsResp = await getJSON<{
        bars: Record<
          string,
          { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }
        >;
        replayDaysList: string[];
      }>(`/api/bars?${barsParams.toString()}`);
      replayDaysList = barsResp.replayDaysList;
      for (const [tf, arr] of Object.entries(barsResp.bars)) {
        if (!(tf in TF_MS) || arr.t.length === 0) continue;
        preBarsByTf.set(
          tf as TF,
          arr.t.map((time, i) => ({
            t: time,
            o: arr.o[i],
            h: arr.h[i],
            l: arr.l[i],
            c: arr.c[i],
            v: arr.v[i],
          })),
        );
      }
    } catch {
      // No prehistory — the session still works (replay days build live).
    }

    // Hide landing, show main app
    this.landingPage.hide();

    this.store.state.symbol = info.symbol;
    this.store.state.digits = info.digits;
    this.store.state.day = info.startDay; // for drawings key
    this.store.state.selectedId = null;
    this.store.state.crosshair = null;
    this.store.state.drawings = loadDrawings(info.symbol);
    this.store.state.portfolio = { ...EMPTY_PORTFOLIO, balance: cfg.balance };
    this.store.state.trade.equity = [];
    this.store.state.replay.status = 'loading';
    this.store.state.replay.message = undefined;
    this.store.emit();

    ++this.sessionToken;

    // Configure panes for the session. All panes share one time window
    // (same rightTime + pxPerMs) so timestamps map to the same x in every
    // pane and bars align across timeframes. The window is sized to the
    // COARSEST pane timeframe so a 1d pane isn't zoomed into a 2-hour void,
    // and capped at the loaded data span so sparse prehistory still fills
    // the chart.
    const cols = panes.length <= 1 ? 1 : 2;
    const paneWidth = Math.max(240, (window.innerWidth - 24) / cols);
    const coarsestTf = panes.length ? Math.max(...panes.map((p) => TF_MS[p.tf])) : 300_000;
    let windowMs = coarsestTf * 150;
    const seedBars = preBarsByTf.get('1m') ?? preBarsByTf.get('5m') ?? [];
    if (seedBars.length > 0) {
      const preSpan = info.start - seedBars[0].t;
      windowMs = Math.min(windowMs, Math.max(preSpan + 86_400_000, coarsestTf * 12));
    }
    const pxPerMs = clamp(paneWidth / windowMs, 1e-8, 0.2);
    const margin = 0.02 * (paneWidth / pxPerMs);

    // Clear last session's bars + gap calendar first, then seed prehistory so
    // the calendar is fresh before the panes are positioned on the
    // compressed axis.
    this.store.state.sessionKey += 1;
    this.market.reset();
    for (const [tf, bars] of preBarsByTf) {
      this.market.preloadBars(tf, bars);
    }
    // Position the right edge on the compressed axis (weekend gaps before the
    // session start are already collapsed at this point).
    const startDisplay = this.market.gaps.compress(info.start) + margin;

    for (const pane of panes) {
      pane.pxPerMs = pxPerMs;
      pane.plotWidth = paneWidth;
      pane.rightTime = startDisplay;
      pane.follow = true;
      pane.autoScale = true;
      pane.viewReady = true;
    }
    this.store.emit();

    // Subscribe with ONLY replay days (prehistory is already loaded via bars)
    this.replay.subscribe(
      info.symbol,
      replayDaysList.length > 0 ? replayDaysList : info.days,
      info.start,
      this.store.state.replay.speed,
      false,
      cfg.balance
    );

    // Store session info for restart
    (this as any).lastSessionConfig = cfg;
    (this as any).lastSessionInfo = info;
  }

  private restartSession(): void {
    const cfg = (this as any).lastSessionConfig as SessionConfig | undefined;
    if (cfg) {
      this.startSession(cfg);
    }
  }

  private exitToLanding(): void {
    this.replay.close();
    this.market.reset();
    this.store.state.portfolio = { ...EMPTY_PORTFOLIO };
    this.store.state.trade.equity = [];
    this.store.state.replay.status = 'idle';
    this.store.state.replay.time = 0;
    this.store.state.replay.sessionStart = 0;
    this.store.state.replay.sessionEnd = 0;
    this.store.state.replay.tickCount = 0;
    this.store.emit();
    this.landingPage.show();
  }

  private seek(time: number): void {
    const { sessionStart, sessionEnd } = this.store.state.replay;
    if (!sessionStart || !sessionEnd) return;
    const target = clamp(time, sessionStart, sessionEnd - 1000);
    this.store.state.replay.time = target;
    this.store.state.replay.status = 'loading';
    const rightTime = this.market.gaps.compress(target);
    for (const pane of this.store.state.panes) {
      pane.rightTime = rightTime;
      pane.follow = true;
      pane.autoScale = true;
    }
    this.store.emit();
    // Drop replay bars at/after the seek target; the server re-sends history
    // ticks from the tape start which rebuild the cursor bar. Seeded
    // prehistory bars before the cursor are kept.
    this.market.truncateTo(target);
    this.replay.seek(target);
  }

  private setSpeed(speed: number): void {
    this.store.state.replay.speed = speed;
    localStorage.setItem('bt.speed', String(speed));
    this.replay.setSpeed(speed);
    this.store.emit();
  }

  private cycleSpeed(direction: number): void {
    const idx = this.speeds.indexOf(this.store.state.replay.speed);
    const next = clamp(idx + direction, 0, this.speeds.length - 1);
    this.setSpeed(this.speeds[next]);
  }

  private togglePause(): void {
    const status = this.store.state.replay.status;
    if (status === 'ended' || status === 'error' || status === 'idle') return;
    const paused = status === 'playing';
    this.store.state.replay.status = paused ? 'paused' : 'playing';
    this.replay.setPaused(paused);
    this.store.emit();
  }

  private latest(): void {
    const last = this.market.lastTime ?? this.store.state.replay.time;
    const source = this.store.state.panes[0];
    if (!source) return;
    for (const pane of this.store.state.panes) pane.follow = true;
    const margin = 0.02 * (source.plotWidth / source.pxPerMs);
    this.setView(source.id, this.market.gaps.compress(last) + margin, source.pxPerMs, true);
  }

  private toggleSyncTime(): void {
    const syncTime = !this.store.state.syncTime;
    this.store.state.syncTime = syncTime;
    if (syncTime) {
      const source = this.store.state.panes[0];
      if (source) {
        for (const pane of this.store.state.panes) {
          pane.rightTime = source.rightTime;
          pane.pxPerMs = source.pxPerMs;
        }
      }
    }
    this.store.emit();
  }

  // ---------------------------------------------------------------------- panes

  private nextTf(): TF {
    const used = new Set(this.store.state.panes.map((p) => p.tf));
    for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as TF[]) {
      if (!used.has(tf)) return tf;
    }
    return '5m';
  }

  private addPane(tf: TF): void {
    const seed = this.store.state.panes[0];
    const pane = makePaneState(tf, seed ? { ...seed, id: '' } : undefined);
    pane.rightTime = seed?.rightTime ?? this.store.state.replay.time;
    pane.priceMin = 0;
    pane.priceMax = 1;
    // New panes inherit the seed pane's view so panes stay aligned (same
    // shared time window when Sync is on); the user can zoom out freely.
    this.store.state.panes.push(pane);

    const chart = new ChartPane(this, pane.id);
    this.panes.set(pane.id, chart);
    this.grid.append(chart.el);
    this.applyLayout();
    this.store.emit();
  }

  closePane(id: string): void {
    if (this.store.state.panes.length <= 1) return;
    const chart = this.panes.get(id);
    chart?.destroy();
    this.panes.delete(id);
    this.store.state.panes = this.store.state.panes.filter((p) => p.id !== id);
    this.applyLayout();
    this.store.emit();
  }

  private setLayout(count: number): void {
    const target = clamp(count, 1, 4);
    while (this.store.state.panes.length < target) this.addPane(this.nextTf());
    while (this.store.state.panes.length > target) {
      const last = this.store.state.panes[this.store.state.panes.length - 1];
      if (!last) break;
      this.closePane(last.id);
    }
    this.applyLayout();
    this.store.emit();
  }

  private applyLayout(): void {
    this.grid.className = `layout-${Math.min(4, Math.max(1, this.store.state.panes.length))}`;
  }

  // --------------------------------------------------------------------- drawing

  private pushUndo(): void {
    this.undoStack.push(
      this.store.state.drawings.map((d) => ({ ...d, a: { ...d.a }, b: { ...d.b } })),
    );
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  private persistDrawings(): void {
    const { symbol, drawings, syncDrawings } = this.store.state;
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      saveDrawings(symbol, drawings);
      if (syncDrawings && !this.applyingRemote) {
        this.sync.post({ type: 'drawings', symbol, drawings });
      }
    }, 120);
  }

  commitDrawing(kind: DrawingKind, a: Point, b: Point): void {
    const drawing: Drawing = { id: uid(), kind, a, b, color: this.store.state.color };
    this.pushUndo();
    this.store.update({ drawings: [...this.store.state.drawings, drawing], selectedId: drawing.id });
    this.persistDrawings();
  }

  updateDrawing(id: string, patch: Pick<Drawing, 'a' | 'b'>): void {
    const drawings = this.store.state.drawings.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this.store.update({ drawings });
    this.persistDrawings();
  }

  removeDrawing(id: string): void {
    this.pushUndo();
    this.store.update({
      drawings: this.store.state.drawings.filter((d) => d.id !== id),
      selectedId: this.store.state.selectedId === id ? null : this.store.state.selectedId,
    });
    this.persistDrawings();
  }

  select(id: string | null): void {
    this.store.update({ selectedId: id });
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.store.update({ drawings: previous, selectedId: null });
    this.persistDrawings();
  }

  private clearDrawings(): void {
    if (this.store.state.drawings.length === 0) return;
    this.pushUndo();
    this.store.update({ drawings: [], selectedId: null });
    this.persistDrawings();
  }

  // ------------------------------------------------------------------ host hooks

  focusPane(id: string): void {
    for (const [paneId, pane] of this.panes) {
      pane.el.classList.toggle('focused', paneId === id);
    }
  }

  setView(id: string, rightTime: number, pxPerMs: number, follow?: boolean): void {
    this.store.setView(id, rightTime, pxPerMs, follow);
    if (!this.store.state.syncTime || this.applyingRemote) return;
    window.clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => {
      this.sync.post({ type: 'view', rightTime, pxPerMs });
    }, 100);
  }

  patchPane(id: string, patch: Partial<PaneState>, emit = true): void {
    this.store.patchPane(id, patch, emit);
  }

  setCrosshair(c: AppState['crosshair']): void {
    this.store.update({ crosshair: c });
    if (this.applyingRemote || !c) return;
    this.sync.post({ type: 'crosshair', time: c.time, price: c.price });
  }

  // -------------------------------------------------------------------- updates

  private onMarketUpdate(): void {
    const last = this.market.lastTime;
    if (last === null) return;
    this.updateStatus();
    const followers = this.store.state.panes.filter((p) => p.follow);
    if (!followers.length) return;
    const source = followers[0];
    const target = this.market.gaps.compress(last) + 0.02 * (source.plotWidth / source.pxPerMs);
    if (target > source.rightTime + 1) {
      this.setView(source.id, target, source.pxPerMs);
    }
  }

  /**
   * Equity accounting happens at the replay cursor: realized cash from the
   * server + unrealized marked at this batch's last tick. One point per tick
   * batch (a few/sec at low speed, ~20/s at 1000x) is plenty for the sparkline.
   */
  private pushEquity(t: number, price: number): void {
    const p = this.store.state.portfolio;
    if (p.position === 0 && p.cash === p.balance) {
      if (this.store.state.trade.equity.length) this.store.state.trade.equity = [];
      return;
    }
    const unreal = p.position ? p.position * (price - p.avgPrice) : 0;
    const curve = this.store.state.trade.equity;
    curve.push({ t, e: p.cash + unreal });
    if (curve.length > 4000) {
      const kept: EquityPoint[] = [];
      for (let i = 0; i < curve.length; i += 2) kept.push(curve[i]);
      this.store.state.trade.equity = kept;
    }
  }

  private updateStatus(): void {
    const state = this.store.state;
    const clock = state.replay.time ? fmtClock(state.replay.time) : '--:--:-- UTC';
    if (this.clockEl.textContent !== clock) this.clockEl.textContent = clock;

    if (!this.scrubbing) {
      const span = state.replay.sessionEnd - state.replay.sessionStart;
      const pct = span > 0 ? (state.replay.time - state.replay.sessionStart) / span : 0;
      const value = String(Math.round(clamp(pct, 0, 1) * 1000));
      if (this.scrubber.value !== value) this.scrubber.value = value;
    }
    const info = (this as any).lastSessionInfo as SessionInfo | undefined;
    const rangeHint = info
      ? ` ${info.days[0]} → ${info.days[info.days.length - 1]} (${info.days.length} days)`
      : '';
    const hint = `${this.market.tickCount.toLocaleString()} ticks loaded${rangeHint} · ${state.drawings.length} drawing${
      state.drawings.length === 1 ? '' : 's'
    } · ${state.panes.length} pane${state.panes.length === 1 ? '' : 's'} · scroll = zoom, drag axes = stretch`;
    if (this.hintEl.textContent !== hint) this.hintEl.textContent = hint;

    this.toolbar?.update(state);
    this.tradePanel?.update(state, state.trade.equity, this.market.lastPrice ?? 0);
  }
}

const app = new App();
app.boot().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'failed to start';
  const grid = document.getElementById('grid')!;
  grid.className = 'layout-1';
  grid.innerHTML = `
    <div class="pane is-empty">
      <div class="empty" style="display:flex;flex-direction:column;gap:10px">
        <strong>Cannot reach the replay backend</strong>
        <span>${message}</span>
        <span>Start it with <code>cd backend && .venv/bin/python -m app.main</code>, then reload.</span>
      </div>
    </div>`;
  console.error(err);
});

// Expose for debugging in the dev console.
(window as unknown as { app: App }).app = app;