import type { Portfolio } from '../types';

export interface SessionInfo {
  symbol: string;
  days: string[];
  digits: number;
  startDay: string;
  endDay: string;
  start: number;
  tapeStart: number;
  end: number;
  time: number;
  speed: number;
  tickCount: number;
}

export interface ReplayStateMsg {
  time: number;
  speed: number;
  paused: boolean;
  ended: boolean;
}

type Handlers = {
  session: (s: SessionInfo) => void;
  reset: () => void;
  history: (t: Float64Array, p: Float64Array, s: Float64Array) => void;
  ticks: (t: Float64Array, p: Float64Array, s: Float64Array) => void;
  state: (s: ReplayStateMsg) => void;
  portfolio: (p: Portfolio) => void;
  error: (message: string) => void;
  close: () => void;
};

/**
 * Binary tick frame layout (see backend/app/main.py, TICK_HDR):
 *   u8 kind (1 = history, 2 = ticks), 3x reserved, u32 count,
 *   f64 cursor time, then count Float64 t, p, s columns.
 * Little-endian; JS DataView/Float64Array reads little-endian by default on
 * every supported platform, and TypedArray aliases are disallowed on exotic
 * endianness anyway, so a plain cast is safe.
 */
const KIND_HISTORY = 1;
const KIND_TICKS = 2;

function decodeTickFrame(buf: ArrayBuffer): { kind: number; t: Float64Array; p: Float64Array; s: Float64Array } | null {
  if (buf.byteLength < 16) return null;
  const view = new DataView(buf);
  const kind = view.getUint8(0);
  const count = view.getUint32(4, true);
  const floats = count * 24;
  if (16 + floats > buf.byteLength) return null;
  return {
    kind,
    t: new Float64Array(buf, 16, count),
    p: new Float64Array(buf, 16 + count * 8, count),
    s: new Float64Array(buf, 16 + count * 16, count),
  };
}

/**
 * WebSocket replay client. The server paces the virtual clock; this class only
 * forwards commands and decoded tick batches.
 */
export class ReplayClient {
  private ws: WebSocket | null = null;
  private handlers: Partial<Handlers> = {};
  private pendingSubscribe: {
    symbol: string;
    days: string[];
    startTime: number;
    speed: number;
    paused: boolean;
    balance: number;
  } | null = null;

  on<K extends keyof Handlers>(name: K, fn: Handlers[K]): void {
    this.handlers[name] = fn;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/replay`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.pendingSubscribe) {
        this.send({ type: 'subscribe', ...this.pendingSubscribe });
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          this.route(JSON.parse(ev.data));
        } catch {
          return;
        }
        return;
      }
      const frame = decodeTickFrame(ev.data as ArrayBuffer);
      if (!frame) return;
      const { kind, t, p, s } = frame;
      if (!t.length) return;
      if (kind === KIND_HISTORY) this.handlers.history?.(t, p, s);
      else if (kind === KIND_TICKS) this.handlers.ticks?.(t, p, s);
    };
    ws.onerror = () => this.handlers.error?.('Connection to replay server failed');
    ws.onclose = () => {
      this.ws = null;
      this.handlers.close?.();
    };
  }

  private route(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'session':
        this.handlers.session?.(msg as unknown as SessionInfo);
        break;
      case 'reset':
        this.handlers.reset?.();
        break;
      case 'state':
        this.handlers.state?.(msg as unknown as ReplayStateMsg);
        break;
      case 'portfolio':
        this.handlers.portfolio?.(msg as unknown as Portfolio);
        break;
      case 'error':
        this.handlers.error?.(String(msg.message ?? 'unknown error'));
        break;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  subscribe(symbol: string, days: string[], startTime: number, speed: number, paused: boolean, balance: number): void {
    this.pendingSubscribe = { symbol, days, startTime, speed, paused, balance };
    this.connect();
    if (this.connected) this.send({ type: 'subscribe', ...this.pendingSubscribe });
  }

  setSpeed(speed: number): void {
    this.send({ type: 'speed', speed });
  }

  setPaused(paused: boolean): void {
    this.send({ type: 'pause', paused });
  }

  seek(time: number): void {
    this.send({ type: 'seek', time });
  }

  placeOrder(
    kind: 'market' | 'limit' | 'stop',
    side: 'buy' | 'sell',
    size: number,
    price?: number,
    sl?: number | null,
    tp?: number | null,
  ): void {
    this.send({ type: 'order', kind, side, size, price, sl: sl ?? undefined, tp: tp ?? undefined });
  }

  cancelOrder(id: string): void {
    this.send({ type: 'cancel', id });
  }

  resetBook(): void {
    this.send({ type: 'bookreset' });
  }

  flatten(): void {
    this.send({ type: 'flatten' });
  }

  setSltp(sl: number | null, tp: number | null): void {
    this.send({ type: 'sltp', sl: sl ?? undefined, tp: tp ?? undefined });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
