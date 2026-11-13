# FX Backtester

A local-first forex/stock **replay backtester** with a TradingView-style
multi-pane chart. Configure a session on the setup screen, then replay the
tape at 0.5×–1000× while trading against the cursor. Every pane can show a
different timeframe of the same symbol while sharing one time window, so a
trendline drawn on the 1m chart lands in the right place on the 5m or 1h
chart as the tape plays forward.

```
┌────────────────────────────── toolbar ─────────────────────────────┐
│ transport · speed · layout · tools · sync · trade · exit           │
├───────────────────┬───────────────────┬───────────────────────────┤
│  XAUUSD 5m        │  XAUUSD 1m        │  (up to 4 panes)          │
│  candles + draws  │  candles + draws  │                           │
├───────────────────┴───────────────────┴───────────────────────────┤
│ replay clock · session scrubber · tick counter · trade dock        │
└───────────────────────────────────────────────────────────────────┘
```

Everything runs on your machine: the backend reads tick exports you dropped
in yourself, serves the built frontend, and keeps state in `localStorage`
and flat files. No accounts, no network calls, no telemetry.

## Features

- **Setup screen** — symbol (chips or any custom ticker), start/end dates
  with quick ranges (1 week → 1 year), preload history stepper (0–365 days,
  presets 5/10/30/90d), tick data path/format/timezone, account
  (balance, currency incl. ZAR, leverage up to 1:2000). A session summary
  panel derives trading days and a timeline preview live, and a four-item
  checklist gates **Start replay**.
- **Data verification** — **Scan data** runs a real check against the
  engine's tick store: path readable, ticks exist for the symbol, the tape
  covers your dates, and the preload window is available. Failures show the
  reason inline.
- **Replay engine** — server-paced virtual clock, 0.5×–1000×, pause/resume,
  scrub/seek, prehistory bars before the cursor, end-of-session handling.
  Dead tape (weekends, long gaps) fast-forwards in one frame instead of
  stalling pacing.
- **Multi-pane, multi-timeframe** — 1–4 panes, per-pane timeframe
  (`1m 5m 15m 30m 1h 4h 1d`), all panes share the same time window and
  zoom together by default.
- **Session-gap compression** — weekend/multi-day gaps collapse to a small
  epsilon on the time axis (no chart-wide voids), while intraday maintenance
  breaks stay true to the data. Raw epoch timestamps remain canonical for
  data, trades and drawings.
- **TradingView-style scaling** — wheel to zoom time, drag the time axis to
  stretch/compress time, drag the price axis to stretch/compress price, drag
  the plot to pan, double-click an axis to reset.
- **Drawing tools** — trend line, horizontal line, rectangle, Fibonacci
  retracement, eraser; select, move, resize, delete, undo. Drawings are
  stored as `(timestamp, price)` pairs, so they project correctly into every
  pane and timeframe, and persist per symbol.
- **Order simulation** — market/limit/stop orders against the replay cursor,
  optional SL/TP, net position with flips, realized + unrealized P&L, equity
  sparkline, session stats (win rate, profit factor, max drawdown), trade
  log with CSV export, B/S hotkeys. Fills draw on every pane.
- **Cross-window sync** — `BroadcastChannel` keeps drawings, time window,
  crosshair and symbol in sync across tabs/windows of the same origin.

## Quick start (development)

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

Single-origin run (FastAPI serves the built frontend):

```bash
cd frontend && npm run build
cd ../backend && .venv/bin/python -m uvicorn app.main:app --port 8000
# open http://127.0.0.1:8000
```

## Desktop app (Electron)

```bash
npm install                      # root: electron + electron-builder
npm run electron                 # spawns the Python backend, then the window
BT_DEV_URL=http://localhost:5173 npm run electron   # dev with Vite HMR
```

### Build installers

```bash
npm run dist                     # frontend build + PyInstaller backend + electron-builder
ls dist/                         # Backtester-0.1.0.AppImage, backtester-desktop_*.deb
```

`npm run dist` runs three steps: `npm run build:frontend` (tsc + vite),
`npm run build:backend` (PyInstaller one-file → `backend/dist/backtester-backend`),
then electron-builder (AppImage + deb; Windows/macOS targets are configured
but untested).

### Running the packaged app

```bash
./dist/Backtester-0.1.0.AppImage --no-sandbox
```

The packaged app keeps its data in its own sandbox (`~/.config/backtester-desktop/data`).
To reuse the tick store you already imported into `backend/data`, point it
there — an external `BT_DATA_DIR` always wins:

```bash
BT_DATA_DIR=$HOME/Documents/Projects/Backtester_desktop/backend/data \
  ./dist/Backtester-0.1.0.AppImage --no-sandbox
# or permanently:
mkdir -p ~/.config/backtester-desktop
ln -s /path/to/backend/data ~/.config/backtester-desktop/data
```

Notes:

- **Sandbox error?** If the AppImage aborts with "the SUID sandbox helper
  binary was found, but is not configured correctly", that is the FUSE mount
  stripping the set-UID bit from `chrome-sandbox`, not an app bug. Use
  `--appimage-extract-and-run` (keeps the sandbox), `--no-sandbox` (quick,
  less isolated), or install the deb — its post-install script fixes the
  sandbox permissions.
- **Stale UI after a rebuild?** The backend sends `Cache-Control: no-cache`
  on HTML and the Electron main process clears the Chromium session cache on
  boot, so the window always loads the current bundle. If you still see an
  old interface, delete `~/.config/backtester-desktop/Cache` and relaunch.
- Electron watches the backend's stdin (`BT_WATCH_STDIN=1`), so the server
  exits when the app quits instead of orphaning itself on port 8000.

## The setup screen

The first page collects and validates one config object and hands it to the
replay engine — it draws no charts and reads no files itself.

| Card | Fields |
| --- | --- |
| **01 Market and period** | symbol chips + custom input (forced uppercase, `A–Z 0–9 . _`); start/end dates; quick range chips (end date anchored); preload history stepper + presets; timeline preview |
| **02 Tick data** | path (folder or file) with native **Browse** picker; **Scan data** verification; file format (CSV / Parquet / Dukascopy .bi5 / MT5 export); timestamp timezone (UTC / EET / New York 17:00) |
| **03 Account** | starting balance; currency (USD, EUR, GBP, JPY, ZAR); leverage (1:30 … 1:2000) |

The sticky session summary derives trading days (weekdays in the range),
the timeline preview, and the auto session name. **Start replay** is enabled
only when all four checklist items pass: symbol selected, valid date range,
tick path set, and a scan that verifies the data covers
`start − preload → end`.

Editing anything except account fields invalidates the last scan; changing
symbol/dates/path updates the checklist immediately.

## Controls

| Action | Input |
| --- | --- |
| Pan chart | drag plot |
| Zoom time | wheel, or drag the bottom time axis |
| Stretch/compress price | drag the right price axis |
| Pan time | Shift + wheel |
| Reset price scale / time window | double-click the respective axis |
| Draw | pick a tool, drag on the chart (single click for H-line) |
| Move / resize drawing | pointer tool, drag body or endpoint |
| Delete drawing | select + `Delete`, or eraser tool |
| Undo | `Ctrl/Cmd + Z` |
| Play / pause | `Space` |
| Seek ±30s / ±5min | `←` / `→`, Shift for 5 minutes |
| Speed up / down | `+` / `-` |
| Layout 1–4 panes | `1`–`4` |
| Buy / sell ticket | `B` / `S` |
| Cancel tool | `Esc` |

## Data

Out of the box the app generates a deterministic synthetic tape: a Brownian
bridge pinned to the next session open (no midnight gaps), session-shaped
volatility, log-normal trade sizes, weekends closed, cash-session hours for
stocks. Cached under `backend/.cache/ticks/<SYMBOL>/<DAY>.v2.npz`.

**Real data — MetaTrader 5 tick exports:**

1. Drop the exported files into `MT5_CSV/<SYMBOL>_CSV/` (any number of files,
   per symbol), then:

   ```bash
   cd backend
   .venv/bin/python -m app.import_mt5                       # every *_CSV folder
   .venv/bin/python -m app.import_mt5 XAUUSD                # one symbol
   .venv/bin/python -m app.import_mt5 XAUUSD --side mid     # mid prices
   .venv/bin/python -m app.import_mt5 EURUSD --start 2026-01-05 --end 2026-03-31
   ```

   Files stream day by day into `backend/data/ticks/<SYMBOL>/<date>.csv.gz`
   and the setup screen's scan lists them automatically. Broker suffixes like
   `XAUUSDm` / `EURUSD.pro` map to the base ticker. Times are taken exactly
   as MT5 exports them (terminal time, treated as UTC).

2. Any CSV export with `timestamp,price,size` (epoch ms or ISO-8601), placed
   at `backend/data/ticks/<SYMBOL>/<YYYY-MM-DD>.csv[.gz]`.

The `CompositeStore` prefers real files over the synthetic tape
automatically — a session on a symbol with real exports never mixes in
synthetic days. Adjust `INSTRUMENTS` in `backend/app/config.py` for digits
and session metadata of new symbols.

## Architecture

```
Browser (Electron renderer)
├─ ChartPane × N          canvas render + pointer interaction, per-pane projection
├─ Store                  app state, panes, drawings, replay status
├─ MarketData  ← Web Worker (candle builder for all timeframes + gap calendar)
├─ ReplayClient           WebSocket, paced binary tick batches
├─ SyncChannel            BroadcastChannel ↔ other windows
└─ LandingPage            setup screen: config, scan, checklist

FastAPI
├─ /api/instruments | scan | days | bars | session | timeframes
├─ /ws/replay             virtual clock, seek/pause/speed, prehistory, order book
└─ CompositeStore         real days (CSV, from MT5) | synthetic (npz cache)
```

### Why it is built this way

- **Drawings are `(time, price)`, never pixels.** Each pane has its own
  projection (`timeToX`, `priceToY`), so one drawing model renders correctly
  on any timeframe without conversion or per-pane copies. The projection is
  also where session gaps are compressed — raw epoch stays canonical for
  data, trades and drawings.
- **Panes share `rightTime` and `pxPerMs`.** That is what "same symbol,
  different timeframe, same window" means mathematically. Price scale stays
  per-pane; the **Sync** toggle lets panes zoom independently.
- **Prehistory is one batch request.** `GET /api/bars` returns every
  requested timeframe at once, so all panes — and any timeframe you switch
  to later — are seeded before the replay starts without a tick-level
  history load. Only the replay period streams over WebSocket.
- **Candle aggregation lives in a Web Worker.** The tape is aggregated into
  all seven timeframes at once, so switching a pane's timeframe is instant
  and never refetches. Only the last forming bar is re-sent per batch.
- **The server owns the replay clock.** Speed changes, pause and seek take
  effect on the next 50 ms frame, and the client cannot outrun the feed.
  Tape gaps longer than 10 minutes fast-forward the virtual clock to the
  next tick, so a weekend costs one frame of wall time instead of minutes.
- **The setup screen never touches files.** Verification goes through
  `GET /api/scan`, which checks path readability, symbol coverage, the
  replay period and the preload window against the engine's own tick store
  and returns pass/fail lines with reasons.

### Replay protocol (`/ws/replay`)

Client → server:

```jsonc
{"type":"subscribe","symbol":"XAUUSD","days":["2026-09-25","2026-09-28"],
 "startTime":1793308800000,"speed":10,"paused":false,"balance":10000}
{"type":"speed","speed":100}
{"type":"pause","paused":true}
{"type":"seek","time":1793263200000}
```

The `days` list (1–400 dates) resolves the whole multi-day session — the
replay walks day to day without re-subscribing. `balance` seeds the
trading book.

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
then count Float64 times, prices, sizes (little-endian)   →  16 + 24·count bytes
```

History comes first in 65,536-tick chunks so the UI can paint while it
loads; live ticks stream in paced batches. Decoding is a plain `Float64Array`
cast on the client — no parse step — and the three columns share one buffer
that is transferred zero-copy into the candle-builder worker.

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
moment the tape touches it (limit/stop/SL/TP). P&L is in quote currency,
size in instrument units. The account resets on seek/restart (fills made at
other cursor times would be meaningless).

## Tests

```bash
cd backend && .venv/bin/python -m pytest      # 36 tests
cd frontend && npm run typecheck && npm run build
```

Covered: tick determinism, session bounds, weekend gaps, day-to-day
continuity, replay pacing/frame caps/seek clamping, dead-tape fast-forward,
MT5 import round-trips, binary tick frame layout, order matching
(market/limit/stop/SL/TP, flips, partial closes) and P&L/session stats.

## Project layout

```
backend/
  app/{main,replay,store,synth,import_mt5,config}.py
  run.py                 # PyInstaller / `python run.py` entry point
  tests/
  data/ticks/            # real exports (gitignored)
frontend/
  src/chart/{pane,drawings}.ts
  src/data/{market,worker,replay,gaps}.ts
  src/{main,store,sync,types,util}.ts
  src/ui/{landing,toolbar,trade}.ts
electron/{main,preload}.cjs
scripts/build_backend.sh
```

## Roadmap

1. **Storage at scale** — swap `TickStore` for TimescaleDB (hypertable on
   `(symbol, ts)`, compression policy) or ClickHouse; the interface is one
   method. Add multi-day date-range loading.
2. **Chart types** — tick/range/renko bars, volume profile, session breaks,
   split-adjusted stock data.
3. **Drawings v2** — per-day scoping option, text/arrow/measure tools,
   magnet mode, copy/paste, JSON import/export.
4. **Multi-window** — real Electron pop-out windows (currently tabs/windows
   of the same origin), window layout persistence.
5. **Performance** — typed-array bar storage with columnar buffers instead
   of per-bar objects in the renderer. *(Binary tick frames are done:
   Float64Array over WS, zero-copy transfer into the worker.)*
6. **Setup screen** — real MT5 import in-app (so packaged installs don't
   depend on env vars or symlinks), Parquet/.bi5/MT5-format loaders behind
   the format selector, timezone conversion.
7. **Packaging** — verify PyInstaller + electron-builder on Windows (Linux
   targets verified), an app icon, code signing, auto-update.
