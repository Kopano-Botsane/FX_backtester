import type { AppState, Drawing } from './types';

/**
 * Cross-window synchronisation (Electron pop-outs, second monitors, browser
 * tabs). In-app panes share the store directly; this channel keeps separate
 * windows on the same symbol/time/drawings.
 */

type Message =
  | { type: 'drawings'; symbol: string; drawings: Drawing[]; origin: string }
  | { type: 'view'; rightTime: number; pxPerMs: number; origin: string }
  | { type: 'crosshair'; time: number; price: number; origin: string }
  | { type: 'symbol'; symbol: string; origin: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class SyncChannel {
  private channel: BroadcastChannel | null = null;
  readonly origin = Math.random().toString(36).slice(2);

  onDrawings: ((symbol: string, drawings: Drawing[]) => void) | null = null;
  onView: ((rightTime: number, pxPerMs: number) => void) | null = null;
  onCrosshair: ((c: AppState['crosshair']) => void) | null = null;
  onSymbol: ((symbol: string) => void) | null = null;

  constructor() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('backtester-sync');
    this.channel.onmessage = (ev: MessageEvent<Message>) => this.handle(ev.data);
  }

  private handle(msg: Message): void {
    if (!msg || msg.origin === this.origin) return;
    switch (msg.type) {
      case 'drawings':
        this.onDrawings?.(msg.symbol, msg.drawings);
        break;
      case 'view':
        this.onView?.(msg.rightTime, msg.pxPerMs);
        break;
      case 'crosshair':
        this.onCrosshair?.({ time: msg.time, price: msg.price, source: 'remote' });
        break;
      case 'symbol':
        this.onSymbol?.(msg.symbol);
        break;
    }
  }

  post(msg: DistributiveOmit<Message, 'origin'>): void {
    this.channel?.postMessage({ ...msg, origin: this.origin } as Message);
  }

  close(): void {
    this.channel?.close();
  }
}
