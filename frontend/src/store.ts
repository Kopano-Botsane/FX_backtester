import type { AppState, PaneState } from './types';

export type Listener = () => void;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  update(patch: Partial<AppState>): void {
    Object.assign(this.state, patch);
    this.emit();
  }

  pane(id: string): PaneState | undefined {
    return this.state.panes.find((p) => p.id === id);
  }

  patchPane(id: string, patch: Partial<PaneState>, emit = true): void {
    const pane = this.pane(id);
    if (!pane) return;
    Object.assign(pane, patch);
    if (emit) this.emit();
  }

  /** Time view is shared when syncing; each pane still owns its price scale. */
  setView(sourceId: string, rightTime: number, pxPerMs: number, follow?: boolean): void {
    const target = this.pane(sourceId);
    if (!target) return;
    target.rightTime = rightTime;
    target.pxPerMs = pxPerMs;
    if (follow !== undefined) target.follow = follow;
    if (this.state.syncTime) {
      for (const pane of this.state.panes) {
        if (pane.id === sourceId) continue;
        pane.rightTime = rightTime;
        pane.pxPerMs = pxPerMs;
        if (follow !== undefined) pane.follow = follow;
      }
    }
    this.emit();
  }
}

const DRAWINGS_PREFIX = 'bt.drawings.';

export function loadDrawings(symbol: string): AppState['drawings'] {
  try {
    const raw = localStorage.getItem(DRAWINGS_PREFIX + symbol);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AppState['drawings'];
    return Array.isArray(parsed) ? parsed.filter((d) => d && d.a && d.b) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(symbol: string, drawings: AppState['drawings']): void {
  try {
    localStorage.setItem(DRAWINGS_PREFIX + symbol, JSON.stringify(drawings));
  } catch {
    /* quota / private mode: drawings stay in-memory */
  }
}
