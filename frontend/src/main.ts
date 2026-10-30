import './styles.css';
import { ChartPane, type ChartHost } from './chart/pane';
import { MarketData } from './data/market';
import { ReplayClient, type SessionInfo } from './data/replay';
import { Store, loadDrawings, saveDrawings } from './store';
import { SyncChannel } from './sync';
import {
  TF_MS,
  type AppState,
  type Drawing,
  type DrawingKind,
  type InstrumentInfo,
  type PaneState,
  type Point,
  type TF,
  type Tool,
} from './types';
import { Toolbar } from './ui/toolbar';
import { clamp, fmtClock, isTypingTarget, uid } from './util';

interface InstrumentMeta {
  instruments: InstrumentInfo[];
  speeds: number[];
  timeframes: string[];
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
  days: string[] = [];

  private panes = new Map<string, ChartPane>();
  private grid = document.getElementById('grid')!;
  private toolbar!: Toolbar;
  private clockEl!: HTMLElement;
  private scrubber!: HTMLInputElement;
  private hintEl!: HTMLElement;
  private undoStack: Drawing[][] = [];
  private persistTimer = 0;
  private viewTimer = 0;
  private applyingRemote = false;
  private scrubbing = false;
  private defaultStart = 0;
  private sessionToken = 0;

  constructor() {
    this.store = new Store({
      symbol: 'EURUSD',
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

    this.buildToolbar(meta);
    this.buildStatusBar();
    this.addPane('5m');
    this.addPane('1m');
    this.wireReplay();
    this.wireSync();
    this.wireKeyboard();

    await this.loadDays('EURUSD');
    await this.loadSession();
  }

  private buildToolbar(meta: InstrumentMeta): void {
    this.toolbar = new Toolbar(document.getElementById('toolbar')!, meta.instruments, meta.speeds, {
      onSymbol: (symbol) => this.switchSymbol(symbol),
      onDay: (day) => void this.loadSession({ day }),
      onSpeed: (speed) => this.setSpeed(speed),
      onPauseToggle: () => this.togglePause(),
      onRestart: () => void this.loadSession({ startTime: this.defaultStart }),
      onLayout: (count) => this.setLayout(count),
      onTool: (tool: Tool) => this.store.update({ tool, selectedId: null }),
      onColor: (color) => this.store.update({ color }),
      onSyncTime: () => this.toggleSyncTime(),
      onUndo: () => this.undo(),
      onClearDrawings: () => this.clearDrawings(),
      onLatest: () => this.latest(),
    });
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
      if (!this.defaultStart) this.defaultStart = s.time;
      this.store.emit();
    });
    this.replay.on('reset', () => {
      this.market.reset();
      this.store.state.replay.status = 'loading';
      this.store.emit();
    });
    this.replay.on('history', (t, p, s) => this.market.append(t, p, s));
    this.replay.on('ticks', (t, p, s) => {
      this.market.append(t, p, s);
      if (this.store.state.replay.status === 'loading') {
        this.store.state.replay.status = 'playing';
        this.store.emit();
      }
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
    this.sync.onSymbol = (symbol) => {
      if (symbol === this.store.state.symbol) return;
      void this.switchSymbol(symbol, false);
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
      }
    });
  }

  // -------------------------------------------------------------------- session

  private digitsFor(symbol: string): number {
    return this.instruments.find((i) => i.symbol === symbol)?.digits ?? 5;
  }

  private async loadDays(symbol: string): Promise<void> {
    const res = await getJSON<{ days: string[] }>(`/api/days?symbol=${encodeURIComponent(symbol)}`);
    if (this.store.state.symbol !== symbol) return; // superseded by a newer switch
    this.days = res.days;
    const day = this.days.includes(this.store.state.day) ? this.store.state.day : this.days[0] ?? '';
    this.store.state.day = day;
    this.toolbar.setDays(this.days, day);
    this.store.emit();
  }

  private async loadSession(opts: { day?: string; startTime?: number } = {}): Promise<void> {
    const symbol = this.store.state.symbol;
    const day = opts.day ?? this.store.state.day;
    if (!day) return;

    this.store.state.day = day;
    this.store.state.digits = this.digitsFor(symbol);
    this.store.state.selectedId = null;
    this.store.state.crosshair = null;
    this.store.state.drawings = loadDrawings(symbol);
    this.store.state.replay.status = 'loading';
    this.store.state.replay.message = undefined;
    this.store.emit();

    const token = ++this.sessionToken;
    try {
      const info = await getJSON<SessionInfo & { defaultStart: number }>(
        `/api/session?symbol=${encodeURIComponent(symbol)}&day=${encodeURIComponent(day)}`,
      );
      if (token !== this.sessionToken) return; // a newer session is loading
      this.defaultStart = info.defaultStart;
      const startTime = clamp(opts.startTime ?? info.defaultStart, info.start, info.end - 1000);

      this.store.state.replay.time = startTime;
      this.store.state.replay.sessionStart = info.start;
      this.store.state.replay.sessionEnd = info.end;
      this.store.state.replay.tickCount = info.tickCount;

      // Panes share one time window unless the user turns time-sync off: that is
      // what makes drawings line up across timeframes. Size it to ~150 bars of
      // the finest pane so the coarser panes still show readable candles.
      const panes = this.store.state.panes;
      const finest = panes.length ? Math.min(...panes.map((p) => TF_MS[p.tf])) : 60_000;
      const cols = panes.length <= 1 ? 1 : 2;
      const paneWidth = Math.max(240, (window.innerWidth - 24) / cols);
      const initialPxPerMs = clamp(paneWidth / (finest * 150), 1e-8, 0.2);
      const margin = 0.02 * (paneWidth / initialPxPerMs);

      for (const pane of panes) {
        pane.pxPerMs = initialPxPerMs;
        pane.plotWidth = paneWidth;
        pane.rightTime = startTime + margin;
        pane.viewReady = true;
        pane.follow = true;
        pane.autoScale = true;
      }
      this.store.state.sessionKey += 1;
      this.market.reset();
      this.store.emit();

      this.replay.subscribe(symbol, day, startTime, this.store.state.replay.speed);
    } catch (err) {
      if (token !== this.sessionToken) return;
      this.store.state.replay.status = 'error';
      this.store.state.replay.message = err instanceof Error ? err.message : 'failed to load session';
      this.store.emit();
    }
  }

  private async switchSymbol(symbol: string, broadcast = true): Promise<void> {
    if (symbol === this.store.state.symbol) return;
    if (broadcast) this.sync.post({ type: 'symbol', symbol });
    saveDrawings(this.store.state.symbol, this.store.state.drawings);
    this.store.state.symbol = symbol;
    this.store.state.digits = this.digitsFor(symbol);
    this.store.emit();
    try {
      await this.loadDays(symbol);
      await this.loadSession({ day: this.days[0] });
    } catch (err) {
      this.store.state.replay.status = 'error';
      this.store.state.replay.message = err instanceof Error ? err.message : 'symbol load failed';
      this.store.emit();
    }
  }

  private seek(time: number): void {
    const { sessionStart, sessionEnd } = this.store.state.replay;
    if (!sessionStart || !sessionEnd) return;
    const target = clamp(time, sessionStart, sessionEnd - 1000);
    this.store.state.replay.time = target;
    this.store.state.replay.status = 'loading';
    for (const pane of this.store.state.panes) {
      pane.rightTime = target;
      pane.follow = true;
      pane.autoScale = true;
    }
    this.store.emit();
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
    this.setView(source.id, last + margin, source.pxPerMs, true);
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
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d', '30m', '1s'] as TF[]) {
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
    pane.viewReady = !!seed?.viewReady;
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
    // Snapshot at schedule time: by the time the debounce fires the active
    // symbol may have changed, which would file these drawings under the wrong
    // instrument.
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
    const target = last + 0.02 * (source.plotWidth / source.pxPerMs);
    if (target > source.rightTime + 1) {
      this.setView(source.id, target, source.pxPerMs);
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
    const hint = `${this.market.tickCount.toLocaleString()} ticks loaded · ${state.drawings.length} drawing${
      state.drawings.length === 1 ? '' : 's'
    } · ${state.panes.length} pane${state.panes.length === 1 ? '' : 's'} · scroll = zoom, drag axes = stretch`;
    if (this.hintEl.textContent !== hint) this.hintEl.textContent = hint;

    this.toolbar?.update(state);
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
        <span>Start it with <code>cd backend &amp;&amp; .venv/bin/python -m app.main</code>, then reload.</span>
      </div>
    </div>`;
  console.error(err);
});

// Expose for debugging in the dev console.
(window as unknown as { app: App }).app = app;
