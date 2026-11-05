import type { AppState, InstrumentInfo, Tool } from '../types';

export interface ToolbarHandlers {
  onSymbol(symbol: string): void;
  onDay(day: string): void;
  onSpeed(speed: number): void;
  onPauseToggle(): void;
  onRestart(): void;
  onLayout(count: number): void;
  onTool(tool: Tool): void;
  onColor(color: string): void;
  onSyncTime(): void;
  onUndo(): void;
  onClearDrawings(): void;
  onLatest(): void;
  onTrade(): void;
}

const TOOLS: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'cursor', icon: '⌖', label: 'Pointer / pan (Esc)' },
  { tool: 'trend', icon: '╱', label: 'Trend line' },
  { tool: 'hline', icon: '─', label: 'Horizontal line' },
  { tool: 'rect', icon: '▭', label: 'Rectangle' },
  { tool: 'fib', icon: 'ƒ', label: 'Fibonacci retracement' },
  { tool: 'eraser', icon: '⌫', label: 'Eraser' },
];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

export class Toolbar {
  readonly el: HTMLElement;
  private symbolSelect: HTMLSelectElement;
  private daySelect: HTMLSelectElement;
  private playBtn: HTMLButtonElement;
  private speedSelect: HTMLSelectElement;
  private layoutButtons: HTMLButtonElement[] = [];
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private syncBtn: HTMLButtonElement;
  private tradeBtn: HTMLButtonElement;
  private statusPill: HTMLSpanElement;

  constructor(root: HTMLElement, instruments: InstrumentInfo[], speeds: number[], handlers: ToolbarHandlers) {
    this.el = root;

    // Symbol
    const symGroup = node('div', 'group');
    this.symbolSelect = node('select');
    this.symbolSelect.title = 'Instrument';
    for (const inst of instruments) {
      const opt = node('option');
      opt.value = inst.symbol;
      opt.textContent = inst.symbol;
      this.symbolSelect.appendChild(opt);
    }
    this.symbolSelect.addEventListener('change', () => handlers.onSymbol(this.symbolSelect.value));
    symGroup.append(this.symbolSelect);

    this.daySelect = node('select');
    this.daySelect.title = 'Trading day (UTC)';
    this.daySelect.addEventListener('change', () => handlers.onDay(this.daySelect.value));
    symGroup.append(this.daySelect);
    this.el.append(symGroup);

    // Transport
    const replayGroup = node('div', 'group');
    const restart = node('button', 'icon', '⏮');
    restart.title = 'Restart session';
    restart.addEventListener('click', () => handlers.onRestart());
    this.playBtn = node('button', 'icon', '▶');
    this.playBtn.title = 'Play / pause (Space)';
    this.playBtn.addEventListener('click', () => handlers.onPauseToggle());
    this.speedSelect = node('select');
    this.speedSelect.title = 'Replay speed';
    for (const speed of speeds) {
      const opt = node('option');
      opt.value = String(speed);
      opt.textContent = `${speed}×`;
      this.speedSelect.appendChild(opt);
    }
    this.speedSelect.addEventListener('change', () => handlers.onSpeed(Number(this.speedSelect.value)));
    this.statusPill = node('span', 'pill');
    const dot = node('span', 'dot');
    this.statusPill.append(dot, node('span', undefined, 'idle'));
    replayGroup.append(restart, this.playBtn, this.speedSelect, this.statusPill);
    this.el.append(replayGroup);

    // Layouts
    const layoutGroup = node('div', 'group');
    for (const count of [1, 2, 3, 4]) {
      const btn = node('button', 'icon', String(count));
      btn.title = `${count} pane${count > 1 ? 's' : ''}`;
      btn.addEventListener('click', () => handlers.onLayout(count));
      this.layoutButtons.push(btn);
      layoutGroup.append(btn);
    }
    this.el.append(layoutGroup);

    // Drawing tools
    const toolGroup = node('div', 'group');
    for (const { tool, icon, label } of TOOLS) {
      const btn = node('button', 'icon', icon);
      btn.title = label;
      btn.dataset.tool = tool;
      btn.addEventListener('click', () => handlers.onTool(tool));
      this.toolButtons.set(tool, btn);
      toolGroup.append(btn);
    }
    const color = node('input');
    color.type = 'color';
    color.value = '#4c8dff';
    color.title = 'Drawing colour';
    color.className = 'swatch';
    color.addEventListener('input', () => handlers.onColor(color.value));
    toolGroup.append(color);
    this.el.append(toolGroup);

    // Trading dock
    const tradeGroup = node('div', 'group');
    this.tradeBtn = node('button', 'icon', '$');
    this.tradeBtn.title = 'Order simulation panel (B/S hotkeys)';
    this.tradeBtn.addEventListener('click', () => handlers.onTrade());
    tradeGroup.append(this.tradeBtn);
    this.el.append(tradeGroup);

    // Actions
    const actionGroup = node('div', 'group');
    const undo = node('button', 'icon', '↺');
    undo.title = 'Undo (Ctrl+Z)';
    undo.addEventListener('click', () => handlers.onUndo());
    const clear = node('button', 'icon', '🗑');
    clear.title = 'Delete all drawings for this symbol';
    clear.addEventListener('click', () => handlers.onClearDrawings());
    const latest = node('button', undefined, 'Latest');
    latest.title = 'Scroll to the newest tick';
    latest.addEventListener('click', () => handlers.onLatest());
    this.syncBtn = node('button', undefined, 'Sync');
    this.syncBtn.title = 'Keep all panes on the same time window';
    this.syncBtn.addEventListener('click', () => handlers.onSyncTime());
    actionGroup.append(undo, clear, latest, this.syncBtn);
    this.el.append(actionGroup);
  }

  setDays(days: string[], selected: string): void {
    this.daySelect.replaceChildren();
    for (const day of days) {
      const opt = node('option');
      opt.value = day;
      opt.textContent = day;
      this.daySelect.appendChild(opt);
    }
    if (selected) this.daySelect.value = selected;
  }

  private setPill(state: AppState): void {
    const status = state.replay.status;
    const label = this.statusPill.lastElementChild as HTMLElement;
    const text =
      status === 'playing' ? 'playing' :
      status === 'paused' ? 'paused' :
      status === 'loading' ? 'loading' :
      status === 'ended' ? 'end of day' :
      status === 'error' ? (state.replay.message ?? 'error') : 'idle';
    label.textContent = text;
    this.statusPill.className = `pill ${status}`;
    this.playBtn.textContent = status === 'playing' ? '⏸' : '▶';
    this.playBtn.disabled = status === 'idle' || status === 'loading' || status === 'error';
  }

  update(state: AppState): void {
    if (this.symbolSelect.value !== state.symbol) this.symbolSelect.value = state.symbol;
    if (this.daySelect.value !== state.day) this.daySelect.value = state.day;
    if (this.speedSelect.value !== String(state.replay.speed)) {
      this.speedSelect.value = String(state.replay.speed);
    }
    for (const [tool, btn] of this.toolButtons) {
      btn.classList.toggle('active', tool === state.tool);
    }
    this.tradeBtn.classList.toggle('active', state.trade.open);
    this.layoutButtons.forEach((btn, idx) => btn.classList.toggle('active', idx + 1 === state.panes.length));
    this.syncBtn.classList.toggle('active', state.syncTime);
    this.setPill(state);
  }
}
