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
}

export interface InstrumentInfo {
  symbol: string;
  name: string;
  kind: string;
  digits: number;
  session: [number, number] | null;
}
