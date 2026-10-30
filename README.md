# Backtester Desktop

A local-first forex/stock **replay backtester** with a TradingView-style multi-pane
chart. Every pane can show a different timeframe of the same symbol while sharing
one time window, so a trendline drawn on the 1m chart appears at the right place on
the 5m, 15m or 1h chart as the tape plays forward.

```
┌───────────────────────────── toolbar ─────────────────────────────┐
│ symbol · day · transport · speed · layout · tools · sync          │
├───────────────────┬───────────────────┬───────────────────────────┤
│  EURUSD 5m        │  EURUSD 1m        │  (optional panes)         │
│  candles + draws  │  candles + draws  │                           │
│  price axis       │  price axis       │                           │
├───────────────────┴───────────────────┴───────────────────────────┤
│ replay clock · session scrubber · tick counter                    │
└───────────────────────────────────────────────────────────────────┘
```

## What works today

- **Replay engine** – server-paced virtual clock, 0.5× → 1000×, pause/resume,
  scrub/seek, prehistory loaded before the cursor, end-of-session handling.
- **Charting** – HTML5 canvas candlesticks, price/time axes, crosshair with
  UTC labels, last-price line, OHLC legend, auto price scaling.
- **Multi-pane, multi-timeframe** – 1/2/3/4 panes, per-pane timeframe
  (`1s … 1d`), all panes share the same time window and zoom by default.
- **TradingView-style scaling** – wheel to zoom horizontally, drag the **time
  axis** to stretch/compress time, drag the **price axis** to stretch/compress
  price, drag the plot to pan, double-click an axis to reset.
- **Drawing tools** – trend line, horizontal line, rectangle, Fibonacci
  retracement, eraser. Select, drag, resize endpoints, delete, undo.
- **Drawings in data space** – stored as `{timestamp, price}` pairs, so they are
  projected correctly into every pane and every timeframe. They persist per
  symbol in `localStorage` and broadcast live to other windows.
- **Cross-window sync** – `BroadcastChannel` keeps drawings, time window,
  crosshair and symbol in sync across tabs / pop-out monitors / Electron windows.
- **Data layer** – deterministic synthetic tape (no network needed) plus a real
  Dukascopy `.bi5` decoder/writer, and a CSV store adapter.

Not built yet: order entry, P&L/position simulation, replay of historical
news, order-flow/tick chart types, drawing persistence on a server, TimescaleDB.
See [Roadmap](#roadmap).

## Quick start

Requirements: Python 3.10+, Node 18+.

```bash
# 1. backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --port 8000

# 2. frontend (second terminal)
cd frontend
npm install
npm run dev          # http://localhost:5173  (proxies /api and /ws to :8000)
```

Production-ish single-origin run (FastAPI serves the built frontend):

```bash
cd frontend && npm run build
cd ../backend && .venv/bin/python -m uvicorn app.main:app --port 8000
# open http://127.0.0.1:8000
```

## Desktop shell (Electron)

```bash
npm install                      # root: electron + electron-builder (~100 MB)
npm run build:frontend
npm run electron                 # starts the Python backend, then the window
BT_DEV_URL=http://localhost:5173 npm run electron   # dev with Vite HMR
```

The main process spawns `backend/.venv/bin/python -m app.main` in development.
For packaging, `npm run build:backend` (PyInstaller one-file) produces
`backend/dist/backtester-backend`, which electron-builder copies to
`resources/backend/`; `frontend/dist` is copied to `resources/frontend/dist`
and the Python process is pointed at it with `BT_FRONTEND_DIST`.

The packaged binary takes `--host` / `--port` (or `BT_HOST` / `BT_PORT`) and
keeps writable state outside the one-file bundle: Electron sets
`BT_DATA_DIR` and `BT_CACHE_DIR` to the app's `userData` directory.
`backend/run.py` is the frozen entry point (the app package uses relative
imports, so `app/main.py` cannot be the PyInstaller script directly).

> The PyInstaller backend has been built and smoke-tested (REST, static
> frontend, WebSocket replay). `electron-builder` installers have not been
> produced in this environment yet.

## Controls

| Action | Input |
| --- | --- |
| Pan chart | drag plot |
| Zoom time | wheel, or drag the bottom time axis |
| Stretch/compress price | drag the right price axis |
| Vertical zoom | wheel over the price axis |
| Pan time | Shift + wheel |
| Reset price scale | double-click the price axis / plot |
| Reset time window | double-click the time axis |
| Draw | pick a tool, drag on the chart (single click for H-line) |
| Move / resize drawing | Pointer tool, drag body or endpoint |
| Delete drawing | select + `Delete`, or Eraser tool |
| Undo | `Ctrl/Cmd + Z` |
| Play / pause | `Space` |
| Seek ±30s / ±5min | `←` / `→`, Shift for 5 minutes |
| Speed up / down | `+` / `-` |
| Layout 1–4 panes | `1`–`4` |
| Cancel tool | `Esc` |

## Architecture

```
Browser (Electron renderer)
├─ ChartPane × N          canvas render + pointer interaction
├─ Store                  app state, panes, drawings, replay status
├─ MarketData  ← Web Worker (candle builder for every timeframe)
├─ ReplayClient           WebSocket, paced tick batches
└─ SyncChannel            BroadcastChannel ↔ other windows

FastAPI
├─ /ws/replay             virtual clock, seek/pause/speed, prehistory
├─ /api/instruments|days|session
└─ TickStore              synthetic (npz cache) | CSV export | Dukascopy ingest
```

### Why it is built this way

- **Drawings are `(time, price)`, never pixels.** Every pane has its own
  projection (`timeToX`, `priceToY`), so one drawing model renders correctly on
  any timeframe without conversion or per-pane copies.
- **Panes share `rightTime` and `pxPerMs`.** That is what "same symbol, different
  timeframe, same window" means mathematically. Price scale stays per-pane.
  Toggle **Sync** off to let panes zoom independently.
- **Candle aggregation lives in a Web Worker.** The tape is aggregated into all
  ten timeframes at once, so switching a pane's timeframe is instant and never
  refetches. Only the last forming bar is re-sent per batch.
- **The server owns the replay clock.** Speed changes, pause and seek take
  effect on the next 50 ms frame, and the client cannot outrun the feed.

### Replay protocol (`/ws/replay`)

Client → server:

```jsonc
{"type":"subscribe","symbol":"EURUSD","day":"2026-10-29","startTime":1793262240000,"speed":10}
{"type":"speed","speed":100}
{"type":"pause","paused":true}
{"type":"seek","time":1793263200000}
```

Server → client:

```jsonc
{"type":"session","symbol":"EURUSD","digits":5,"start":...,"end":...,"time":...,"tickCount":95938}
{"type":"reset"}
{"type":"history","t":[...],"p":[...],"s":[...],"count":5000}
{"type":"ticks","t":[...],"p":[...],"s":[...],"time":...}
{"type":"state","time":...,"speed":10,"paused":false,"ended":false}
```

Ticks are columnar (parallel arrays) and chunked at 5,000 for prehistory.

## Data

Out of the box the app generates a deterministic synthetic tape: a Brownian
bridge pinned to the next session open (so there are no midnight gaps), session
shaped volatility, log-normal trade sizes, weekends closed, cash-session hours
for stocks. It is cached under `backend/.cache/ticks/<SYMBOL>/<DAY>.v2.npz`.

**Real data** – two paths:

1. Dukascopy downloader (decodes the `.bi5` LZMA format directly):

   ```bash
   cd backend
   .venv/bin/python -m app.ingest EURUSD 2026-03-17
   .venv/bin/python -m app.ingest EURUSD 2026-03-17 --hours 8-16
   ```

   Files land in `backend/data/ticks/EURUSD/2026-03-17.csv.gz` and the
   `CompositeStore` prefers them over synthetic data automatically.

2. Any CSV export with `timestamp,price,size` (epoch ms or ISO-8601), placed at
   `backend/data/ticks/<SYMBOL>/<YYYY-MM-DD>.csv[.gz]`.

Adjust `DUKASCOPY_SYMBOLS` in `backend/app/ingest.py` if you need other tickers,
and `INSTRUMENTS` in `backend/app/config.py` for digits/session metadata.

## Tests

```bash
cd backend && .venv/bin/python -m pytest      # 16 tests
cd frontend && npm run typecheck && npm run build
```

Covered: tick determinism, session bounds, weekend gaps, day-to-day continuity,
replay pacing/frame caps/seek clamping, `.bi5` decoding, CSV round-trip.

## Project layout

```
backend/
  app/{main,replay,store,synth,ingest,config}.py
  run.py                 # PyInstaller / `python run.py` entry point
  tests/
  data/ticks/            # real exports (gitignored)
frontend/
  src/chart/{pane,drawings}.ts
  src/data/{market,worker,replay}.ts
  src/{main,store,sync,types,util}.ts
  src/ui/toolbar.ts
electron/{main,preload}.cjs
scripts/build_backend.sh
```

## Roadmap

1. **Order simulation** – market/limit/stop orders, positions, equity curve,
   session statistics, CSV trade export. The replay cursor is already the single
   source of "now", which is what an execution model needs.
2. **Storage at scale** – swap `TickStore` for TimescaleDB (hypertable on
   `(symbol, ts)`, compression policy) or ClickHouse; the interface is one
   method. Add multi-day date-range loading.
3. **Chart types** – tick/range/renko bars, volume profile, session breaks,
   split-adjusted stock data.
4. **Drawings v2** – per-day scoping option, text/arrow/measure tools,
   magnet mode, copy/paste, JSON import/export.
5. **Multi-window** – real Electron pop-out windows (currently tabs/windows of
   the same origin), window layout persistence.
6. **Performance** – binary tick frames (Float64Array over WS) instead of JSON
   for 1000× replay of dense tapes; typed-array bar storage with columnar
   buffers instead of per-bar objects.
7. **Packaging** – verify PyInstaller + electron-builder on Linux/Windows,
   code signing, auto-update.
