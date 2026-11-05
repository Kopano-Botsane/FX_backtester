import type { AppState, EquityPoint, OrderKind, Portfolio, TradeSide } from '../types';
import { fmtClock, fmtMoney, fmtPrice, fmtSignedMoney } from '../util';

export interface TradeHandlers {
  /** Submit whatever the ticket currently holds, on the given side. */
  place(side: TradeSide): void;
  cancel(id: string): void;
  flatten(): void;
  clearSltp(): void;
  reset(): void;
  togglePanel(): void;
}

/**
 * Right-hand trading dock: equity, open position, order ticket, pending
 * orders, session stats and the trade log. No reactivity framework —
 * App.updateStatus() calls update() on every tick batch / state change, and
 * each block only rewrites text when the value actually changed. Lists
 * (pending orders, trade log) rebuild only when their shape changes.
 */
export class TradePanel {
  readonly el: HTMLElement;
  private handlers: TradeHandlers;
  private state: AppState | null = null;

  private equityEl: HTMLElement;
  private cashEl: HTMLElement;
  private unrealEl: HTMLElement;
  private ddEl: HTMLElement;
  private curveCanvas: HTMLCanvasElement;

  private posBox: HTMLElement;
  private posSideEl: HTMLElement;
  private posSizeEl: HTMLElement;
  private posAvgEl: HTMLElement;
  private posUnrealEl: HTMLElement;
  private sltpEl: HTMLElement;
  private sltpLineEl: HTMLElement;
  private flattenBtn: HTMLButtonElement;

  private sideBuyBtn: HTMLButtonElement;
  private sideSellBtn: HTMLButtonElement;
  private kindSelect: HTMLSelectElement;
  private sizeInput: HTMLInputElement;
  private priceInput: HTMLInputElement;
  private slInput: HTMLInputElement;
  private tpInput: HTMLInputElement;
  private ticketNoteEl: HTMLElement;

  private pendingBox: HTMLElement;
  private statsBox: HTMLElement;
  private logBox: HTMLElement;
  private resetBtn: HTMLButtonElement;

  private side: TradeSide = 'buy';
  private curve: EquityPoint[] = [];
  private listSig = '';

  constructor(root: HTMLElement, handlers: TradeHandlers) {
    this.handlers = handlers;
    this.el = root;
    this.el.innerHTML = `
      <div class="t-head">
        <span class="t-title">Trade</span>
        <button class="t-close" title="Hide trading panel">&times;</button>
      </div>

      <div class="t-account">
        <div class="t-eq-row"><span>Equity</span><strong id="t-eq">$0.00</strong></div>
        <div class="t-eq-cols">
          <div><span>Realized</span><em id="t-cash">$0.00</em></div>
          <div><span>Unrealized</span><em id="t-unreal">$0.00</em></div>
          <div><span>Max DD</span><em id="t-dd">$0.00</em></div>
        </div>
        <canvas class="t-curve" height="56"></canvas>
      </div>

      <div class="t-section">
        <div class="t-pos t-flat" id="t-pos">
          <span class="t-pos-side">FLAT</span>
          <div class="t-pos-grid">
            <div><span>Qty</span><em id="t-pos-size">–</em></div>
            <div><span>Avg</span><em id="t-pos-avg">–</em></div>
            <div><span>P&L</span><em id="t-pos-pnl">–</em></div>
          </div>
          <div class="t-sltp t-hidden" id="t-sltp">
            <em id="t-sltp-line"></em>
            <button id="t-sltp-clear" title="Remove stop loss / take profit">×</button>
          </div>
          <button class="t-flatten" id="t-flatten" disabled>Flatten</button>
        </div>
      </div>

      <div class="t-section">
        <div class="t-lbl">Order ticket</div>
        <div class="t-side">
          <button class="t-buy active" id="t-buy">Buy / Long</button>
          <button class="t-sell" id="t-sell">Sell / Short</button>
        </div>
        <div class="t-row3">
          <select id="t-kind" title="Order type">
            <option value="market">Market</option>
            <option value="limit">Limit</option>
            <option value="stop">Stop</option>
          </select>
          <input id="t-size" type="number" min="0" step="any" value="1" title="Size (instrument units)" />
          <input id="t-price" type="number" min="0" step="any" placeholder="trigger" title="Trigger price (limit / stop)" class="t-hidden" />
        </div>
        <div class="t-row3">
          <input id="t-sl" type="number" step="any" placeholder="SL" title="Stop loss (optional)" />
          <input id="t-tp" type="number" step="any" placeholder="TP" title="Take profit (optional)" />
          <button id="t-place" class="t-place">Send order</button>
        </div>
        <div class="t-note" id="t-note">Hotkeys: B buys the ticket, S sells it</div>
      </div>

      <div class="t-section">
        <div class="t-lbl">Pending orders</div>
        <div id="t-pending"><div class="t-empty">none</div></div>
      </div>

      <div class="t-section">
        <div class="t-lbl">Session stats</div>
        <div class="t-stats" id="t-stats"></div>
      </div>

      <div class="t-section t-log-sec">
        <div class="t-lbl-row">
          <span>Trade log</span>
          <button id="t-export" title="Download trades as CSV">CSV</button>
        </div>
        <div class="t-log" id="t-log"><div class="t-empty">no closed trades yet</div></div>
      </div>

      <div class="t-section t-end">
        <button id="t-reset" class="t-hidden" title="Wipe this session's simulated account">Reset account</button>
        <span class="t-note">P&L is in quote currency, size in instrument units. Trading restarts on jump/seek.</span>
      </div>
    `;

    const $ = (sel: string): HTMLElement => root.querySelector<HTMLElement>(sel)!;
    this.equityEl = $('#t-eq');
    this.cashEl = $('#t-cash');
    this.unrealEl = $('#t-unreal');
    this.ddEl = $('#t-dd');
    this.curveCanvas = $('.t-curve') as HTMLCanvasElement;
    this.posBox = $('#t-pos');
    this.posSideEl = $('.t-pos-side');
    this.posSizeEl = $('#t-pos-size');
    this.posAvgEl = $('#t-pos-avg');
    this.posUnrealEl = $('#t-pos-pnl');
    this.sltpEl = $('#t-sltp');
    this.sltpLineEl = $('#t-sltp-line');
    this.flattenBtn = $('#t-flatten') as HTMLButtonElement;
    this.sideBuyBtn = $('#t-buy') as HTMLButtonElement;
    this.sideSellBtn = $('#t-sell') as HTMLButtonElement;
    this.kindSelect = $('#t-kind') as HTMLSelectElement;
    this.sizeInput = $('#t-size') as HTMLInputElement;
    this.priceInput = $('#t-price') as HTMLInputElement;
    this.slInput = $('#t-sl') as HTMLInputElement;
    this.tpInput = $('#t-tp') as HTMLInputElement;
    this.ticketNoteEl = $('#t-note');
    this.pendingBox = $('#t-pending');
    this.statsBox = $('#t-stats');
    this.logBox = $('#t-log');
    this.resetBtn = $('#t-reset') as HTMLButtonElement;

    this.sideBuyBtn.addEventListener('click', () => this.setSide('buy'));
    this.sideSellBtn.addEventListener('click', () => this.setSide('sell'));
    this.kindSelect.addEventListener('change', () => {
      this.priceInput.classList.toggle('t-hidden', this.kindSelect.value === 'market');
    });
    $('#t-place').addEventListener('click', () => this.handlers.place(this.side));
    this.flattenBtn.addEventListener('click', () => this.handlers.flatten());
    $('#t-sltp-clear').addEventListener('click', () => this.handlers.clearSltp());
    $('.t-close').addEventListener('click', () => this.handlers.togglePanel());
    $('#t-export').addEventListener('click', () => this.exportCsv());
    this.resetBtn.addEventListener('click', () => this.handlers.reset());
  }

  setSide(side: TradeSide): void {
    this.side = side;
    this.sideBuyBtn.classList.toggle('active', side === 'buy');
    this.sideSellBtn.classList.toggle('active', side === 'sell');
  }

  /** What "Send order" / the B & S hotkeys submit right now. */
  ticket(): {
    kind: OrderKind;
    side: TradeSide;
    size: number;
    price?: number;
    sl?: number;
    tp?: number;
  } {
    const kind = this.kindSelect.value as OrderKind;
    const num = (el: HTMLInputElement): number | undefined => {
      const raw = el.value.trim();
      if (raw === '') return undefined;
      const v = Number(raw);
      return isFinite(v) ? v : undefined;
    };
    const size = Number(this.sizeInput.value);
    return {
      kind,
      side: this.side,
      size: isFinite(size) ? size : 0,
      price: kind === 'market' ? undefined : num(this.priceInput),
      sl: num(this.slInput),
      tp: num(this.tpInput),
    };
  }

  setNote(text: string): void {
    if (this.ticketNoteEl.textContent !== text) this.ticketNoteEl.textContent = text;
  }

  /** Called on every tick batch and every store emit. */
  update(state: AppState, curve: EquityPoint[], lastPrice: number): void {
    this.state = state;
    this.curve = curve;
    const p = state.portfolio;
    const price = lastPrice || p.lastPrice || p.avgPrice || 0;
    const unreal = p.position ? p.position * (price - p.avgPrice) : 0;
    const equity = p.cash + unreal;

    this.setText(this.equityEl, fmtMoney(equity));
    this.setText(this.cashEl, fmtSignedMoney(p.cash));
    this.setText(this.unrealEl, fmtSignedMoney(unreal));
    if (this.unrealEl.className !== (unreal >= 0 ? 'up' : 'down')) this.unrealEl.className = unreal >= 0 ? 'up' : 'down';
    this.setText(this.ddEl, fmtMoney(p.stats.maxDrawdown));

    this.drawCurve(equity, ptsFirst(curve));
    this.drawPos(p, state, unreal);
    this.flattenBtn.disabled = p.position === 0;

    const sig = `${p.pending.length}|${p.trades.length}|${p.stats.count}|0`;
    if (sig !== this.listSig) {
      this.listSig = sig;
      this.renderPending(p, state);
      this.renderStats(p);
      this.renderLog(p, state);
    }
    const dirty = p.trades.length > 0 || p.cash !== 0 || p.position !== 0;
    this.resetBtn.classList.toggle('t-hidden', !dirty);
  }

  private setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  private drawPos(p: Portfolio, state: AppState, unreal: number): void {
    const flat = p.position === 0;
    const sideLabel = flat ? 'flat' : p.position > 0 ? 'LONG' : 'SHORT';
    if (this.posBox.dataset.side !== sideLabel) this.posBox.dataset.side = sideLabel;
    this.posBox.classList.toggle('t-flat', flat);
    this.posSideEl.textContent = flat ? 'FLAT' : sideLabel;
    if (flat) {
      this.posSizeEl.textContent = '–';
      this.posAvgEl.textContent = '–';
      this.posUnrealEl.textContent = '–';
    } else {
      this.posSizeEl.textContent = String(Math.abs(p.position));
      this.posAvgEl.textContent = fmtPrice(p.avgPrice, state.digits);
      this.posUnrealEl.textContent = fmtSignedMoney(unreal);
      this.posUnrealEl.className = unreal >= 0 ? 'up' : 'down';
    }
    const sltp = !flat && (p.sl !== null || p.tp !== null);
    this.sltpEl.classList.toggle('t-hidden', !sltp);
    if (sltp) {
      const parts = [
        p.sl !== null ? `SL ${fmtPrice(p.sl, state.digits)}` : '',
        p.tp !== null ? `TP ${fmtPrice(p.tp, state.digits)}` : '',
      ].filter(Boolean).join('  ·  ');
      this.setText(this.sltpLineEl, parts);
    }
  }

  private drawCurve(equity: number, first: number | undefined): void {
    const canvas = this.curveCanvas;
    const w = canvas.clientWidth || 236;
    if (canvas.width !== w || canvas.height !== 56) {
      canvas.width = w;
      canvas.height = 56;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, 56);
    const pts = this.curve;
    ctx.strokeStyle = '#232c38';
    ctx.beginPath();
    ctx.moveTo(0, 55.5);
    ctx.lineTo(w, 55.5);
    ctx.stroke();
    if (pts.length < 2) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const pt of pts) {
      if (pt.e < lo) lo = pt.e;
      if (pt.e > hi) hi = pt.e;
    }
    if (hi - lo < 1e-9) hi = lo + 1e-9;
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const y = (e: number) => 52 - ((e - lo) / (hi - lo)) * 46;
    const up = first === undefined ? equity >= 0 : equity >= first;
    ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = 4 + (i / (pts.length - 1)) * (w - 8);
      if (i === 0) ctx.moveTo(x, y(pts[i].e));
      else ctx.lineTo(x, y(pts[i].e));
    }
    ctx.stroke();
  }

  private fmtT(ms: number): string {
    // "dd Mon, hh:mm:ss" – same shape as the status clock minus the zone.
    return fmtClock(ms).replace(' UTC', '');
  }

  private renderPending(p: Portfolio, state: AppState): void {
    const box = this.pendingBox;
    box.replaceChildren();
    if (!p.pending.length) {
      box.innerHTML = '<div class="t-empty">none</div>';
      return;
    }
    for (const o of p.pending) {
      const row = document.createElement('div');
      row.className = 't-pending-row';
      const tag = document.createElement('span');
      tag.className = o.side === 'buy' ? 'up' : 'down';
      tag.textContent = `${o.side.toUpperCase()} ${o.kind.toUpperCase()} ${o.size} @ ${fmtPrice(o.price, state.digits)}`;
      const cancel = document.createElement('button');
      cancel.textContent = '×';
      cancel.title = 'Cancel order';
      cancel.addEventListener('click', () => this.handlers.cancel(o.id));
      row.append(tag, cancel);
      box.append(row);
    }
  }

  private renderStats(p: Portfolio): void {
    const s = p.stats;
    const pf = s.profitFactor === null ? '–' : s.profitFactor.toFixed(2);
    this.statsBox.innerHTML =
      `<div><span>Trades</span><em>${s.count}</em></div>` +
      `<div><span>Win rate</span><em>${(s.winRate * 100).toFixed(0)}%</em></div>` +
      `<div><span>Profit factor</span><em>${pf}</em></div>` +
      `<div><span>Net P&L</span><em>${fmtSignedMoney(s.expectancy)}</em></div>`;
  }

  private renderLog(p: Portfolio, state: AppState): void {
    const box = this.logBox;
    box.replaceChildren();
    if (!p.trades.length) {
      box.innerHTML = '<div class="t-empty">no closed trades yet</div>';
      return;
    }
    for (const t of [...p.trades].reverse()) {
      const row = document.createElement('div');
      row.className = 't-trade-row';
      const pnlCls = t.pnl >= 0 ? 'up' : 'down';
      const sign = t.pnl >= 0 ? '+' : '';
      row.innerHTML =
        `<span class="t-col-time">${this.fmtT(t.exitT)}</span>` +
        `<span class="${t.side === 'buy' ? 'up' : 'down'} t-col-side">${t.side === 'buy' ? 'L' : 'S'}</span>` +
        `<span class="t-col-qty">${t.size}</span>` +
        `<span class="t-col-price">${fmtPrice(t.entryPrice, state.digits)}→${fmtPrice(t.exitPrice, state.digits)}</span>` +
        `<span class="t-col-pnl ${pnlCls}">${sign}${t.pnl.toFixed(2)}</span>`;
      box.append(row);
    }
  }

  private exportCsv(): void {
    const state = this.state;
    if (!state || !state.portfolio.trades.length) return;
    const rows: string[] = ['exit_time,side,size,entry_time,entry_price,exit_time,exit_price,pnl,reason'];
    for (const t of state.portfolio.trades) {
      rows.push(
        [
          new Date(t.exitT).toISOString(),
          t.side,
          t.size,
          new Date(t.entryT).toISOString(),
          t.entryPrice,
          new Date(t.exitT).toISOString(),
          t.exitPrice,
          t.pnl.toFixed(2),
          t.reason,
        ].join(','),
      );
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades-${state.symbol}-${state.day}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function ptsFirst(curve: EquityPoint[]): number | undefined {
  return curve.length ? curve[0].e : undefined;
}
