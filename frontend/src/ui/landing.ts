import type { SessionConfig } from '../types';

export interface LandingHandlers {
  start(cfg: SessionConfig): void;
}

export class LandingPage {
  readonly el: HTMLElement;
  private handlers: LandingHandlers;
  private symbolSelect: HTMLSelectElement;
  private balanceInput: HTMLInputElement;
  private startDateInput: HTMLInputElement;
  private endDateInput: HTMLInputElement;
  private historyDaysInput: HTMLInputElement;
  private errorEl: HTMLElement;

  constructor(root: HTMLElement, handlers: LandingHandlers) {
    this.handlers = handlers;
    this.el = root;
    this.el.innerHTML = `
      <div class="landing">
        <div class="landing-card">
          <h1>Backtester</h1>
          <p class="subtitle">Local-first replay backtesting</p>

          <div class="field">
            <label>Symbol</label>
            <select id="land-symbol" disabled>
              <option value="">Loading…</option>
            </select>
          </div>

          <div class="field">
            <label>Account balance (quote currency)</label>
            <input id="land-balance" type="number" min="1" step="1" value="10000" />
          </div>

          <div class="field">
            <label>Start date</label>
            <input id="land-start" type="date" />
          </div>

          <div class="field">
            <label>End date (optional — defaults to latest)</label>
            <input id="land-end" type="date" />
          </div>

          <div class="field">
            <label>Preload history (days before start, max 60)</label>
            <input id="land-hist" type="number" min="0" max="60" step="1" value="5" />
          </div>

          <div id="land-error" class="error hidden"></div>

          <button id="land-start-btn" class="primary">Start session</button>
        </div>
      </div>
    `;

    this.symbolSelect = this.el.querySelector('#land-symbol')!;
    this.balanceInput = this.el.querySelector('#land-balance')!;
    this.startDateInput = this.el.querySelector('#land-start')!;
    this.endDateInput = this.el.querySelector('#land-end')!;
    this.historyDaysInput = this.el.querySelector('#land-hist')!;
    this.errorEl = this.el.querySelector('#land-error')!;

    this.el.querySelector('#land-start-btn')!.addEventListener('click', () => this.submit());
  }

  /** Called after /api/instruments resolves. */
  setSymbols(symbols: { symbol: string; name: string }[]): void {
    this.symbolSelect.innerHTML = symbols
      .map(s => `<option value="${s.symbol}">${s.symbol} — ${s.name}</option>`)
      .join('');
    this.symbolSelect.disabled = false;
    // Persisted config
    const saved = localStorage.getItem('bt.sessionCfg');
    if (saved) {
      try {
        const cfg = JSON.parse(saved);
        if (cfg.symbol) this.symbolSelect.value = cfg.symbol;
        if (cfg.balance) this.balanceInput.value = String(cfg.balance);
        if (cfg.start) this.startDateInput.value = cfg.start;
        if (cfg.end) this.endDateInput.value = cfg.end;
        if (cfg.historyDays !== undefined) this.historyDaysInput.value = String(cfg.historyDays);
      } catch { }
    }
    // Default start date = latest available day (will be set by caller after /api/days)
  }

  /** Called after /api/days resolves for the selected symbol. */
  setDays(days: string[]): void {
    if (!days.length) return;
    const latest = days[0];
    if (!this.startDateInput.value) this.startDateInput.value = latest;
    this.startDateInput.max = latest;
    this.endDateInput.max = latest;
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.classList.remove('hidden');
  }

  private clearError(): void {
    this.errorEl.classList.add('hidden');
  }

  private async submit(): Promise<void> {
    this.clearError();
    const symbol = this.symbolSelect.value;
    const balance = Number(this.balanceInput.value);
    const start = this.startDateInput.value;
    const end = this.endDateInput.value || null;
    const historyDays = Number(this.historyDaysInput.value);

    if (!symbol) { this.showError('Select a symbol'); return; }
    if (!Number.isFinite(balance) || balance <= 0) { this.showError('Balance must be a positive number'); return; }
    if (!start) { this.showError('Start date is required'); return; }

    const cfg: SessionConfig = { symbol, balance, start, end, historyDays };
    localStorage.setItem('bt.sessionCfg', JSON.stringify(cfg));
    this.handlers.start(cfg);
  }

  show(): void {
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }
}