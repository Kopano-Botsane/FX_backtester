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
- **Order simulation** – market/limit/stop orders against the replay cursor,
  optional SL/TP bonding to the position, net position with flips, realized +
  unrealized P&L, equity sparkline, session stats (win rate, profit factor,
  max drawdown), trade log with CSV export and B/S hotkeys. Trades draw on the
  chart as markers + entry→exit connectors in every pane/timeframe.
- **Data layer** – deterministic synthetic tape (no network needed) plus an
  MT5 tick-export importer that streams real tapes into the same store.

Not built yet: historical news replay, order-flow/tick chart types, drawing
persistence on a server, TimescaleDB. See [Roadmap](#roadmap).

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

```bash
npm run dist                     # frontend + PyInstaller + electron-builder
ls dist/                         # Backtester-0.1.0.AppImage, *.deb
```

Electron leaves a pipe open on the backend's stdin (`BT_WATCH_STDIN=1`), so
the server exits when the app quits or crashes instead of orphaning itself on
port 8000.

> Linux installers have been built and the AppImage launched end to end
> (bundled backend, live ticks, clean shutdown). Windows/macOS targets are
> configured but unbuilt, and both platforms still use the stock Electron icon.

#### AppImage sandbox error

If you run the AppImage directly and Chromium aborts with
"the SUID sandbox helper binary was found, but is not configured correctly",
that is the FUSE mount stripping the set-UID bit from `chrome-sandbox`, not a
bug in the app. Use one of:

```bash
./dist/Backtester-0.1.0.AppImage --appimage-extract-and-run   # keeps the sandbox
./dist/Backtester-0.1.0.AppImage --no-sandbox                 # quick, less isolated
sudo dpkg -i dist/backtester-desktop_0.1.0_amd64.deb          # best: full sandbox,
                                                              # postinst chmods 4755
```

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
└─ TickStore              synthetic (npz cache) | real days (CSV, from MT5)
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
{"type":"session","symbol":"XAUUSD","digits":2,"start":...,"end":...,"time":...,"tickCount":348929}
{"type":"reset"}
{"type":"state","time":...,"speed":10,"paused":false,"ended":false}
```

Tick data arrives as *binary WebSocket frames*, not JSON:

```
u8  kind  (1 = history, 2 = replayed ticks), 3x reserved
u32 count
f64 cursor time when the batch was cut
then count Float64 times, prices, sizes (little-endian)   → 16 + 24·count bytes
```

History comes first in 65,536-tick chunks so the UI can paint while it loads;
live ticks stream in paced batches. Decoding is a plain `Float64Array` cast on
the client — no parse step — and the three columns share one buffer that is
transferred zero-copy into the candle-builder worker.

**Trading messages** (JSON, both ways):

```jsonc
// client → server
{"type":"order","kind":"market|limit|stop","side":"buy|sell","size":1,"price":...,"sl":...,"tp":...}
{"type":"cancel","id":"..."}  {"type":"flatten"}  {"type":"sltp","sl":...,"tp":...}  {"type":"bookreset"}

// server → client (pushed on every fill/position/stat change)
{"type":"portfolio","cash":...,"position":...,"avgPrice":...,"sl":...,"tp":...,
 "pending":[...],"fills":[...],"trades":[...],"stats":{...}}
```

Fills happen at the cursor's last price (market) or at the trigger price the
moment the tape touches it (limit/stop/SL/TP). P&L is in quote currency, size
in instrument units. The account resets on seek/restart (fills made at other
cursor times would be meaningless).

## Data

Out of the box the app generates a deterministic synthetic tape: a Brownian
bridge pinned to the next session open (so there are no midnight gaps), session
shaped volatility, log-normal trade sizes, weekends closed, cash-session hours
for stocks. It is cached under `backend/.cache/ticks/<SYMBOL>/<DAY>.v2.npz`.

**Real data** – MetaTrader 5 tick exports:

1. Drop the exported files into `MT5_CSV/<SYMBOL>_CSV/` (any number, per
   symbol), then:

   ```bash
   cd backend
   .venv/bin/python -m app.import_mt5                       # every *_CSV folder
   .venv/bin/python -m app.import_mt5 XAUUSD                # one symbol
   .venv/bin/python -m app.import_mt5 XAUUSD --side mid     # mid prices
   .venv/bin/python -m app.import_mt5 EURUSD --start 2026-01-05 --end 2026-03-31
   ```

   Files stream day by day into `backend/data/ticks/<SYMBOL>/<date>.csv.gz`
   and the day picker lists them automatically. Broker suffixes like
   `XAUUSDm` / `EURUSD.pro` map to the base ticker. Times are taken exactly
   as MT5 exports them (terminal time, treated as UTC).

2. Any CSV export with `timestamp,price,size` (epoch ms or ISO-8601), placed at
   `backend/data/ticks/<SYMBOL>/<YYYY-MM-DD>.csv[.gz]`.

All of these land in `backend/data/ticks/<SYMBOL>/<date>.csv.gz` and the
`CompositeStore` prefers real files over the synthetic tape automatically.

Adjust `INSTRUMENTS` in `backend/app/config.py` for digits/session metadata of
new symbols.

## Tests

```bash
cd backend && .venv/bin/python -m pytest      # 35 tests
cd frontend && npm run typecheck && npm run build
```

Covered: tick determinism, session bounds, weekend gaps, day-to-day continuity,
replay pacing/frame caps/seek clamping, MT5 import round-trips, binary tick
frame layout, order matching (market/limit/stop/SL/TP, flips, partial closes)
and P&L/session stats.

## Project layout

```
backend/
  app/{main,replay,store,synth,import_mt5,config}.py
  run.py                 # PyInstaller / `python run.py` entry point
  tests/
  data/ticks/            # real exports (gitignored)
frontend/
  src/chart/{pane,drawings}.ts
  src/data/{market,worker,replay}.ts
  src/{main,store,sync,types,util}.ts
  src/ui/{toolbar,trade}.ts
electron/{main,preload}.cjs
scripts/build_backend.sh
```

## Roadmap

1. **Storage at scale** – swap `TickStore` for TimescaleDB (hypertable on
   `(symbol, ts)`, compression policy) or ClickHouse; the interface is one
   method. Add multi-day date-range loading.
2. **Chart types** – tick/range/renko bars, volume profile, session breaks,
   split-adjusted stock data.
3. **Drawings v2** – per-day scoping option, text/arrow/measure tools,
   magnet mode, copy/paste, JSON import/export.
4. **Multi-window** – real Electron pop-out windows (currently tabs/windows of
   the same origin), window layout persistence.
5. **Performance** – typed-array bar storage with columnar buffers instead of
   per-bar objects in the renderer. *(Binary tick frames are done: Float64Array
   over WS, zero-copy transfer into the worker.)*
6. **Packaging** – verify PyInstaller + electron-builder on Windows
   (`linux` targets verified), an app icon, code signing, auto-update.
