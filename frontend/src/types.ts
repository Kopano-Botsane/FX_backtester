export type TF = '1s' | '5s' | '15s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export const TF_MS: Record<TF, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '15s': 15_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const TF_LIST: TF[] = ['1s', '5s', '15s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'];

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Point {
  t: number;
  p: number;
}

export type DrawingKind = 'trend' | 'hline' | 'rect' | 'fib';

export interface Drawing {
  id: string;
  kind: DrawingKind;
  a: Point;
  b: Point;
  color: string;
}

export type Tool = 'cursor' | 'trend' | 'hline' | 'rect' | 'fib' | 'eraser';

export interface PaneState {
  id: string;
  tf: TF;
  priceMin: number;
  priceMax: number;
  rightTime: number;
  pxPerMs: number;
  plotWidth: number;
  follow: boolean;
  autoScale: boolean;
  viewReady: boolean;
}

export type ReplayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface ReplayState {
  status: ReplayStatus;
  speed: number;
  time: number;
  sessionStart: number;
  sessionEnd: number;
  tickCount: number;
  message?: string;
}

/** Session trading state: the account book mirrored from the server. */
export interface TradingState {
  open: boolean;
  equity: EquityPoint[];
}

export interface AppState {
  symbol: string;
  digits: number;
  day: string;
  panes: PaneState[];
  tool: Tool;
  color: string;
  drawings: Drawing[];
  selectedId: string | null;
  crosshair: { time: number; price: number; source: string } | null;
  syncTime: boolean;
  syncDrawings: boolean;
  replay: ReplayState;
  sessionKey: number;
  portfolio: Portfolio;
  trade: TradingState;
}

// ------------------------------------------------------------- simulated trading

export type OrderKind = 'market' | 'limit' | 'stop';
export type TradeSide = 'buy' | 'sell';

export interface TFill {
  id: string;
  t: number;
  price: number;
  size: number;
  side: TradeSide;
  kind: OrderKind | 'sl' | 'tp';
  role: 'entry' | 'close' | 'flip';
}

export interface TTrade {
  id: string;
  side: TradeSide;
  size: number;
  entryId: string;
  entryT: number;
  entryPrice: number;
  exitId: string;
  exitT: number;
  exitPrice: number;
  pnl: number;
  reason: 'order' | 'sl' | 'tp' | 'flatten';
}

export interface PendingOrder {
  id: string;
  kind: 'limit' | 'stop';
  side: TradeSide;
  size: number;
  price: number;
  t: number;
}

export interface SessionStats {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
}

export interface Portfolio {
  cash: number;
  position: number;
  avgPrice: number;
  lastPrice: number;
  sl: number | null;
  tp: number | null;
  pending: PendingOrder[];
  fills: TFill[];
  trades: TTrade[];
  stats: SessionStats;
  balance: number;
}

export const EMPTY_PORTFOLIO: Portfolio = {
  cash: 0,
  position: 0,
  avgPrice: 0,
  lastPrice: 0,
  sl: null,
  tp: null,
  pending: [],
  fills: [],
  trades: [],
  stats: {
    count: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: null,
    avgWin: 0,
    avgLoss: 0,
    expectancy: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
  },
  balance: 0,
};

export interface EquityPoint {
  t: number;
  e: number;
}

export interface SessionConfig {
  symbol: string;
  balance: number;
  start: string;
  end: string | null;
  historyDays: number;
}

export interface InstrumentInfo {
  symbol: string;
  name: string;
  kind: string;
  digits: number;
  session: [number, number] | null;
}
