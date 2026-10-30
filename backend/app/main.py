"""FastAPI application: instrument metadata + paced tick replay websocket."""

from __future__ import annotations

import asyncio
import os
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
from .store import CompositeStore, Ticks, default_start_ms

app = FastAPI(title="Backtester Replay API", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

store = CompositeStore()

# Small in-process cache: a day of ticks is loaded once per symbol/day and shared
# by every socket (ticks are immutable, so sharing is safe).
_day_cache: dict[tuple[str, str], Ticks] = {}


def get_ticks(symbol: str, day: date) -> Ticks:
    key = (symbol, day.isoformat())
    cached = _day_cache.get(key)
    if cached is None:
        cached = store.load(symbol, day)
        if len(_day_cache) > 24:
            _day_cache.pop(next(iter(_day_cache)))
        _day_cache[key] = cached
    return cached


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
        "days": [d.isoformat() for d in store.available_days(symbol)],
    }


@app.get("/api/session")
def session(symbol: str, day: str) -> dict[str, object]:
    symbol = parse_symbol(symbol)
    parsed = parse_day(day)
    ticks = get_ticks(symbol, parsed)
    bounds = store.session(symbol, parsed)
    if len(ticks) == 0:
        raise HTTPException(status_code=404, detail="no data for that day")
    return {
        "symbol": symbol,
        "day": day,
        "digits": INSTRUMENTS[symbol].digits,
        "start": bounds["start"],
        "end": bounds["end"],
        "defaultStart": default_start_ms(symbol, parsed),
        "tickCount": len(ticks),
    }


def encode(batch: Ticks, digits: int) -> dict[str, list]:
    """Compact JSON payload: parallel arrays, prices rounded to instrument digits."""
    return {
        "t": batch.t.tolist(),
        "p": np.round(batch.p, digits).tolist(),
        "s": np.round(batch.s, 4).tolist(),
    }


async def send_ticks(ws: WebSocket, batch: Ticks, digits: int, kind: str, when: int) -> None:
    payload = encode(batch, digits)
    payload.update({"type": kind, "time": when, "count": len(batch)})
    await ws.send_json(payload)


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
                        day = parse_day(str(msg.get("day", "")))
                    except HTTPException as exc:
                        await ws.send_json({"type": "error", "message": str(exc.detail)})
                        continue

                    ticks = get_ticks(symbol, day)
                    if len(ticks) == 0:
                        await ws.send_json({"type": "error", "message": "no data for that day"})
                        continue

                    digits = INSTRUMENTS[symbol].digits
                    start = int(msg.get("startTime") or default_start_ms(symbol, day))
                    speed = float(msg.get("speed") or 10.0)
                    speed = min(max(speed, 0.1), max(SPEEDS))
                    paused = bool(msg.get("paused", False))
                    engine = ReplayEngine(ticks, start, speed)
                    last = time.monotonic()
                    last_state = None

                    await ws.send_json({
                        "type": "session",
                        "symbol": symbol,
                        "day": day.isoformat(),
                        "digits": digits,
                        "start": engine.start,
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
                        await send_ticks(ws, chunk, digits, "history", engine.time)
                        await asyncio.sleep(0)
                    await push_state(force=True)
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
                    await ws.send_json({"type": "reset"})
                    history = engine.history
                    for offset in range(0, len(history), HISTORY_CHUNK):
                        chunk = history.slice(offset, offset + HISTORY_CHUNK)
                        await send_ticks(ws, chunk, digits, "history", engine.time)
                        await asyncio.sleep(0)
                    last_state = None
                    await push_state(force=True)
                    continue

                if kind == "ping":
                    await ws.send_json({"type": "pong"})

            # Pace the virtual clock off the monotonic wall clock.
            now = time.monotonic()
            wall_ms = (now - last) * 1000.0
            last = now
            if engine is not None and not paused and not engine.ended:
                batch = engine.advance(wall_ms)
                if len(batch):
                    await send_ticks(ws, batch, digits, "ticks", engine.time)
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

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
