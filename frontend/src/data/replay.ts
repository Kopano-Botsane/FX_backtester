export interface SessionInfo {
  symbol: string;
  day: string;
  digits: number;
  start: number;
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
  history: (t: number[], p: number[], s: number[]) => void;
  ticks: (t: number[], p: number[], s: number[]) => void;
  state: (s: ReplayStateMsg) => void;
  error: (message: string) => void;
  close: () => void;
};

/**
 * WebSocket replay client. The server paces the virtual clock; this class only
 * forwards commands and decoded tick batches.
 */
export class ReplayClient {
  private ws: WebSocket | null = null;
  private handlers: Partial<Handlers> = {};
  private pendingSubscribe: { symbol: string; day: string; startTime: number; speed: number } | null = null;

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
    this.ws = ws;

    ws.onopen = () => {
      if (this.pendingSubscribe) {
        this.send({ type: 'subscribe', ...this.pendingSubscribe });
      }
    };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.route(msg);
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
      case 'history':
      case 'ticks': {
        const t = msg.t as number[];
        const p = msg.p as number[];
        const s = msg.s as number[];
        if (!t?.length) return;
        if (msg.type === 'history') this.handlers.history?.(t, p, s);
        else this.handlers.ticks?.(t, p, s);
        break;
      }
      case 'state':
        this.handlers.state?.(msg as unknown as ReplayStateMsg);
        break;
      case 'error':
        this.handlers.error?.(String(msg.message ?? 'unknown error'));
        break;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  subscribe(symbol: string, day: string, startTime: number, speed: number): void {
    this.pendingSubscribe = { symbol, day, startTime, speed };
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

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
