"""FastAPI application: instrument metadata + paced tick replay websocket."""

from __future__ import annotations

import asyncio
import os
import struct
import sys
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import (
    FRAME_MS,
    HISTORY_CHUNK,
    INSTRUMENTS,
    ROOT,
    SPEEDS,
    TIMEFRAMES_MS,
)
from .replay import ReplayEngine
from .orders import Book
from . import synth
from .store import CompositeStore, Ticks, Bars, TF_TO_MS, BAR_TIMEFRAMES

app = FastAPI(title="Backtester Replay API", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

store = CompositeStore()

# In-process caches. Days are immutable once loaded, so they are shared across
# sockets and restarts of the same session; the range cache keeps assembled
# multi-day tapes around so pressing Restart/re-subscribing is instant.
_day_cache: dict[tuple[str, str], Ticks] = {}
_range_cache: dict[tuple[str, tuple[str, ...]], Ticks] = {}
MAX_RANGE_TICKS = 40_000_000  # ≈960 MB of three f64 columns


def get_ticks(symbol: str, day: date) -> Ticks:
    key = (symbol, day.isoformat())
    cached = _day_cache.get(key)
    if cached is None:
        cached = store.load(symbol, day)
        if len(_day_cache) > 512:
            for _ in range(64):
                _day_cache.pop(next(iter(_day_cache)))
        _day_cache[key] = cached
    return cached


def get_range_ticks(symbol: str, days: list[date]) -> Ticks:
    key = (symbol, tuple(d.isoformat() for d in days))
    cached = _range_cache.get(key)
    if cached is not None:
        return cached
    total = 0
    parts: list[Ticks] = []
    for day in days:
        part = get_ticks(symbol, day)
        total += len(part)
        if total > MAX_RANGE_TICKS:
            raise ValueError(
                f"range too large: over {MAX_RANGE_TICKS:,} ticks — pull the end date in"
            )
        if len(part):
            parts.append(part)
    if not parts:
        raise ValueError("the selected days contain no tick data")
    if len(_range_cache) > 3:
        _range_cache.pop(next(iter(_range_cache)))
    if len(parts) == 1:
        tape = parts[0]
    else:
        tape = Ticks(
            np.concatenate([p.t for p in parts]),
            np.concatenate([p.p for p in parts]),
            np.concatenate([p.s for p in parts]),
        )
    _range_cache[key] = tape
    return tape


def parse_symbol(symbol: str) -> str:
    symbol = (symbol or "").upper()
    if symbol not in INSTRUMENTS:
        raise HTTPException(status_code=404, detail=f"unknown symbol {symbol!r}")
    return symbol


def parse_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="day must be YYYY-MM-DD") from exc


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "version": __version__,
        "symbols": list(INSTRUMENTS),
        "cachedDays": len(_day_cache),
    }


@app.get("/api/instruments")
def instruments() -> dict[str, object]:
    return {
        "instruments": [
            {
                "symbol": i.symbol,
                "name": i.name,
                "kind": i.kind,
                "digits": i.digits,
                "session": list(i.session) if i.session else None,
            }
            for i in INSTRUMENTS.values()
        ],
        "speeds": list(SPEEDS),
        "timeframes": list(TIMEFRAMES_MS),
    }


@app.get("/api/days")
def days(symbol: str) -> dict[str, object]:
    symbol = parse_symbol(symbol)
    return {
        "symbol": symbol,
        "days": [d.isoformat() for d in store.session_days(symbol)],
    }


@app.get("/api/bars")
def bars(
    symbol: str,
    tf: str,
    start: str,
    end: str | None = None,
    historyDays: int = 5,
) -> dict[str, object]:
    """Return pre-aggregated OHLCV bars for fast prehistory rendering.

    Uses the same day-range logic as /api/session but returns bars instead of
    resolving to a tick tape. The client uses this for prehistory (days before
    the replay start) and switches to WS ticks for the replay period.
    """
    if tf not in TF_TO_MS:
        raise HTTPException(status_code=400, detail=f"unsupported timeframe: {tf}")
    symbol = parse_symbol(symbol)
    start_day = parse_day(start)
    end_day = parse_day(end) if end else None
    if historyDays < 0 or historyDays > 60:
        raise HTTPException(status_code=400, detail="historyDays must be 0-60")
    try:
        days = store.days_for_range(symbol, start_day, end_day, historyDays)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail=f"no data on {exc.args[0]}"
        ) from None

    # Split into prehistory (before start_day) and replay days
    pre_days = [d for d in days if d < start_day]
    replay_days = [d for d in days if d >= start_day]

    pre_bars = store.load_bars(symbol, tf, pre_days) if pre_days else None

    return {
        "symbol": symbol,
        "tf": tf,
        "digits": INSTRUMENTS[symbol].digits,
        "prehistoryDays": len(pre_days),
        "replayDays": len(replay_days),
        "preBars": {
            "t": pre_bars.t.tolist(),
            "o": pre_bars.o.tolist(),
            "h": pre_bars.h.tolist(),
            "l": pre_bars.l.tolist(),
            "c": pre_bars.c.tolist(),
            "v": pre_bars.v.tolist(),
        } if pre_bars is not None and len(pre_bars) > 0 else None,
        "replayDaysList": [d.isoformat() for d in replay_days],
    }


@app.get("/api/session")
def session(
    symbol: str,
    start: str,
    end: str | None = None,
    historyDays: int = 5,
) -> dict[str, object]:
    """Resolve a session: the start replay day plus optional trailing days and
    sessions of preload history before it. Cheap — resolves day lists and
    session bounds without loading any tick tape."""
    symbol = parse_symbol(symbol)
    start_day = parse_day(start)
    end_day = parse_day(end) if end else None
    if historyDays < 0 or historyDays > 60:
        raise HTTPException(status_code=400, detail="historyDays must be 0-60")
    try:
        days = store.days_for_range(symbol, start_day, end_day, historyDays)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail=f"no data on {exc.args[0]}"
        ) from None

    last_day = days[-1]
    instr = INSTRUMENTS[symbol]
    cursor_start = synth.day_bounds_utc(start_day, instr)[0]
    _, session_end = synth.day_bounds_utc(last_day, instr)
    return {
        "symbol": symbol,
        "digits": instr.digits,
        "startDay": start_day.isoformat(),
        "endDay": last_day.isoformat(),
        "days": [d.isoformat() for d in days],
        "start": cursor_start,
        "end": session_end,
        "replayDays": sum(1 for d in days if d >= start_day),
        "prehistoryDays": len(days) - sum(1 for d in days if d >= start_day),
    }


# Binary tick frame layout (little-endian, zero-copy friendly on decode):
#   u8  kind (1 = history, 2 = ticks), 3x reserved, u32 count,
#   f64 cursor time when the batch was cut, then count Float64 times,
#   count Float64 prices, count Float64 sizes — 16 + 24*count bytes.
TICK_HDR = struct.Struct("<B3xId")
KIND_HISTORY = 1
KIND_TICKS = 2


def encode_binary(batch: Ticks, kind: int, when: float) -> bytes:
    n = len(batch.t)
    if n == 0:
        return TICK_HDR.pack(kind, 0, float(when))
    hdr = np.frombuffer(TICK_HDR.pack(kind, n, float(when)), dtype=np.uint8)
    cols = np.empty((3, n), dtype="<f8")
    cols[0] = batch.t
    cols[1] = batch.p
    cols[2] = batch.s
    return hdr.tobytes() + cols.tobytes()


async def send_ticks(ws: WebSocket, batch: Ticks, kind: int, when: int) -> None:
    await ws.send_bytes(encode_binary(batch, kind, when))


@app.websocket("/ws/replay")
async def replay_socket(ws: WebSocket) -> None:
    await ws.accept()
    queue: asyncio.Queue[dict] = asyncio.Queue()

    async def reader() -> None:
        try:
            while True:
                await queue.put(await ws.receive_json())
        except (WebSocketDisconnect, RuntimeError):
            await queue.put({"type": "__disconnect"})
        except Exception:  # malformed frame / transport error
            await queue.put({"type": "__disconnect"})

    reader_task = asyncio.create_task(reader())
    engine: ReplayEngine | None = None
    symbol: str | None = None
    digits = 5
    paused = False
    last_state: tuple | None = None
    last = time.monotonic()

    async def push_state(force: bool = False) -> None:
        nonlocal last_state
        if engine is None:
            return
        state = (engine.time, engine.speed, paused, engine.ended)
        if not force and state == last_state:
            return
        last_state = state
        await ws.send_json({
            "type": "state",
            "time": engine.time,
            "speed": engine.speed,
            "paused": paused,
            "ended": engine.ended,
        })

    book = Book()
    last_portfolio: tuple | None = None

    async def push_portfolio(force: bool = False) -> None:
        # Fills/position changes are rare relative to tick frames, so the
        # signature keeps the panel a reactive push instead of a poll.
        nonlocal last_portfolio
        sig = (
            book.pos, book.avg, book.cash, book.sl, book.tp,
            len(book.pending), len(book.fills), len(book.trades),
        )
        if not force and sig == last_portfolio:
            return
        last_portfolio = sig
        message = {"type": "portfolio"}
        message.update(book.snapshot())
        await ws.send_json(message)

    try:
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=FRAME_MS / 1000)
            except asyncio.TimeoutError:
                msg = None

            if msg is not None:
                kind = msg.get("type")
                if kind == "__disconnect":
                    break

                if kind == "subscribe":
                    try:
                        symbol = parse_symbol(str(msg.get("symbol", "")))
                        raw_days = msg.get("days")
                        if (
                            not isinstance(raw_days, list)
                            or not raw_days
                            or len(raw_days) > 400
                        ):
                            raise ValueError("a 'days' list (1-400 dates) is required")
                        days_ = sorted({parse_day(str(d)) for d in raw_days})
                    except (HTTPException, ValueError) as exc:
                        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
                        await ws.send_json({"type": "error", "message": str(detail)})
                        continue

                    speed = float(msg.get("speed") or 10.0)
                    speed = min(max(speed, 0.1), max(SPEEDS))
                    paused = bool(msg.get("paused", False))
                    balance = float(msg.get("balance") or 0.0)
                    start_time = int(msg.get("startTime") or 0)

                    try:
                        ticks = get_range_ticks(symbol, days_)
                    except ValueError as exc:
                        await ws.send_json({"type": "error", "message": str(exc)})
                        continue

                    digits = INSTRUMENTS[symbol].digits
                    cursor = max(start_time, int(ticks.t[0])) if len(ticks) else start_time
                    cursor = min(cursor, int(ticks.t[-1])) if len(ticks) else cursor
                    engine = ReplayEngine(ticks, cursor, speed)
                    last = time.monotonic()
                    last_state = None
                    # Simulated trading restarts with the session (and on seek):
                    # fills made at other cursor times would be meaningless.
                    book.reset(engine.time, engine.last_price, balance)
                    last_portfolio = None

                    await ws.send_json({
                        "type": "session",
                        "symbol": symbol,
                        "days": [d.isoformat() for d in days_],
                        "digits": digits,
                        "start": engine.time,
                        "tapeStart": int(ticks.t[0]) if len(ticks) else engine.time,
                        "end": engine.end,
                        "time": engine.time,
                        "speed": engine.speed,
                        "tickCount": len(ticks),
                    })

                    # Prehistory, chunked so the client can paint while it loads.
                    history = engine.history
                    await ws.send_json({"type": "reset"})
                    for offset in range(0, len(history), HISTORY_CHUNK):
                        chunk = history.slice(offset, offset + HISTORY_CHUNK)
                        await send_ticks(ws, chunk, KIND_HISTORY, engine.time)
                        await asyncio.sleep(0)
                    await push_state(force=True)
                    await push_portfolio(force=True)
                    continue

                if kind == "speed" and engine is not None:
                    engine.speed = min(max(float(msg.get("speed", engine.speed)), 0.1), max(SPEEDS))
                    await push_state()
                    continue

                if kind == "pause" and engine is not None:
                    paused = bool(msg.get("paused", True))
                    last = time.monotonic()
                    await push_state()
                    continue

                if kind == "seek" and engine is not None and symbol is not None:
                    engine.seek(int(msg.get("time", engine.time)))
                    last = time.monotonic()
                    book.reset(engine.time, engine.last_price)
                    last_portfolio = None
                    await ws.send_json({"type": "reset"})
                    history = engine.history
                    for offset in range(0, len(history), HISTORY_CHUNK):
                        chunk = history.slice(offset, offset + HISTORY_CHUNK)
                        await send_ticks(ws, chunk, KIND_HISTORY, engine.time)
                        await asyncio.sleep(0)
                    last_state = None
                    await push_state(force=True)
                    await push_portfolio(force=True)
                    continue

                if kind == "ping":
                    await ws.send_json({"type": "pong"})
                    continue

                # Trading messages: orders against the current cursor.
                if engine is not None:
                    if kind == "order":
                        try:
                            otype = str(msg.get("kind", "market"))
                            if otype not in ("market", "limit", "stop"):
                                raise ValueError(f"unknown kind {otype!r}")
                            side_raw = str(msg.get("side", "")).lower()
                            if side_raw not in ("buy", "sell"):
                                raise ValueError("side must be buy or sell")
                            size = abs(float(msg.get("size", 0)))
                            price = float(msg.get("price") or 0)
                            sl = msg.get("sl")
                            tp = msg.get("tp")
                            error = book.place(
                                1 if side_raw == "buy" else -1,
                                size,
                                otype,
                                price,
                                float(sl) if sl is not None else None,
                                float(tp) if tp is not None else None,
                            )
                        except (TypeError, ValueError) as exc:
                            error = f"invalid order: {exc}"
                        await push_portfolio(force=True)
                        continue

                    if kind == "cancel" and engine is not None:
                        book.cancel(str(msg.get("id", "")))
                        await push_portfolio(force=True)
                        continue

                    if kind == "flatten" and engine is not None:
                        book.flatten()
                        await push_portfolio(force=True)
                        continue

                    if kind == "sltp" and engine is not None:
                        sl = msg.get("sl")
                        tp = msg.get("tp")
                        book.set_sltp(
                            float(sl) if sl is not None else None,
                            float(tp) if tp is not None else None,
                        )
                        await push_portfolio(force=True)
                        continue

                    if kind == "bookreset" and engine is not None:
                        book.reset(engine.time, engine.last_price)
                        last_portfolio = None
                        await push_portfolio(force=True)
                        continue

            # Pace the virtual clock off the monotonic wall clock.
            now = time.monotonic()
            wall_ms = (now - last) * 1000.0
            last = now
            if engine is not None and not paused and not engine.ended:
                batch = engine.advance(wall_ms)
                if len(batch):
                    await send_ticks(ws, batch, KIND_TICKS, engine.time)
                    book.on_ticks(batch)
                    await push_portfolio()
                await push_state()
            elif engine is not None and engine.ended and last_state is None:
                paused = True
                await push_state(force=True)

    except WebSocketDisconnect:
        pass
    finally:
        reader_task.cancel()


@app.get("/api/timeframes")
def timeframes() -> dict[str, int]:
    return TIMEFRAMES_MS


# Serve the built frontend (Electron / packaged mode) when it exists.
_dist_env = os.environ.get("BT_FRONTEND_DIST")
_dist = Path(_dist_env) if _dist_env else ROOT / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="app")


@app.exception_handler(HTTPException)
def http_error(_request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


def _exit_with_parent() -> None:
    """Quit when the Electron parent quits.

    Electron spawns us with a pipe on stdin that it never writes to, so EOF
    means the shell is gone. Without this, closing the app (or a crash) leaves
    an orphaned server holding the port until the machine reboots.
    """

    def read_until_eof() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=read_until_eof, name="parent-watch", daemon=True).start()


def main() -> None:
    """CLI entry point, also used by the frozen PyInstaller binary.

    The app object is passed directly (not an import string) so it works from a
    one-file bundle, where `app.main` is not importable by module path.
    """
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(prog="backtester-backend")
    parser.add_argument("--host", default=os.environ.get("BT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BT_PORT", "8000")))
    args, _unknown = parser.parse_known_args()

    if os.environ.get("BT_WATCH_STDIN") == "1":
        _exit_with_parent()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
