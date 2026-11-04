"""Deterministic synthetic tick generation.

Why synthetic data first: the replay engine, chart renderer and drawing model
all need a stable, repeatable tape to develop against. Real MT5 exports are
optional and plug in through :class:`app.store.CsvTickStore`; this module
exists so the app is usable with zero network access and so tests are
reproducible.

The generator pins each day's open to the previous day's close (FX/metal) via a
Brownian bridge, so multi-day charts have no artificial midnight jumps.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from functools import lru_cache

import numpy as np

from .config import INSTRUMENTS, Instrument

EPOCH = date(2020, 1, 1)
_DAY_MS = 86_400_000


def _seed(symbol: str, day: date, salt: int = 0) -> int:
    # Stable across processes (unlike hash()).
    raw = f"{symbol}|{day.isoformat()}|{salt}"
    h = 0
    for ch in raw:
        h = (h * 131 + ord(ch)) & 0xFFFFFFFF
    return h


@lru_cache(maxsize=64)
def _daily_return_series(symbol: str) -> np.ndarray:
    """Cumulative log price level per calendar day since EPOCH.

    An Ornstein-Uhlenbeck style pull keeps the synthetic multi-year series in a
    believable band around the instrument's base price (a pure random walk
    drifts to absurd levels over thousands of days).
    """
    instr = INSTRUMENTS[symbol]
    n = (date.today() - EPOCH).days + 400
    rng = np.random.default_rng(_seed(symbol, EPOCH, salt=7))
    shocks = rng.normal(0.0, instr.daily_vol, size=n)
    level = np.empty(n)
    x = 0.0
    pull = 0.0015
    for i, shock in enumerate(shocks):
        x = x * (1.0 - pull) + shock
        level[i] = x
    return level


def day_index(day: date) -> int:
    return (day - EPOCH).days


def open_price(instr: Instrument, day: date) -> float:
    """Continuous open price for ``day`` derived from the daily level series."""
    idx = day_index(day)
    levels = _daily_return_series(instr.symbol)
    if idx <= 0:
        return instr.base_price
    level = levels[min(idx - 1, levels.size - 1)]
    return float(instr.base_price * np.exp(level))


def _activity(hours: np.ndarray, instr: Instrument) -> np.ndarray:
    """Relative tick intensity / volatility through the UTC day."""
    if instr.kind == "stock":
        # U-shaped intraday volume inside the cash session.
        frac = (hours - instr.session[0]) / (instr.session[1] - instr.session[0])
        frac = np.clip(frac, 0.0, 1.0)
        return 0.55 + 1.9 * (np.exp(-frac * 7.0) + np.exp(-(1.0 - frac) * 7.0))
    # FX/metal: Asia lull, London ramp, NY overlap, evening fade.
    g = lambda mu, sigma, amp: amp * np.exp(-0.5 * ((hours - mu) / sigma) ** 2)
    curve = (
        0.35
        + g(3.0, 2.2, 0.35)
        + g(9.0, 2.0, 1.25)
        + g(13.5, 1.6, 1.45)
        + g(16.0, 2.0, 0.8)
    )
    # Weekend quiet (Sat/Sun) is handled by the caller via session hours.
    return curve


def session_bounds(instr: Instrument) -> tuple[float, float]:
    return instr.session if instr.session else (0.0, 24.0)


def generate_ticks(symbol: str, day: date, rng_scale: float = 1.0) -> dict[str, np.ndarray]:
    """Generate one day of ticks: ``t`` (epoch ms), ``p`` (price), ``s`` (size)."""
    if symbol not in INSTRUMENTS:
        raise KeyError(f"unknown symbol: {symbol}")
    instr = INSTRUMENTS[symbol]

    if not is_trading_day(symbol, day):
        empty = np.empty(0)
        return {"t": empty.astype(np.int64), "p": empty, "s": empty}

    start_h, end_h = session_bounds(instr)
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(hours=start_h)
    duration_s = (end_h - start_h) * 3600.0

    rng = np.random.default_rng(_seed(symbol, day, salt=1))
    expected = duration_s / instr.tick_interval_s
    n = int(np.clip(expected * rng.uniform(0.92, 1.08), 500, 400_000))

    # Tick arrival times: exponential inter-arrivals modulated by activity.
    offset_grid = np.linspace(0, duration_s, 4096)
    hours = (start_h + offset_grid / 3600.0) % 24.0
    act_grid = _activity(hours, instr)
    rate = act_grid / act_grid.mean()
    # Thinning: sample candidates at the peak rate, then accept each with
    # probability rate(t)/peak, which yields the intended time-varying intensity.
    peak = float(rate.max())
    candidates = int(n * peak * 1.35) + 32
    raw_dt = rng.exponential(instr.tick_interval_s / peak, size=candidates)
    t_off = np.cumsum(raw_dt)
    t_off = t_off[t_off < duration_s]
    accept = rng.random(t_off.size) < (np.interp(t_off, offset_grid, rate) / peak)
    t_off = t_off[accept]
    if t_off.size < 4:
        t_off = np.linspace(0, duration_s, 64)

    # Sub-second jitter so ticks do not land on round milliseconds.
    t_ms = (
        np.int64(start.replace(tzinfo=timezone.utc).timestamp() * 1000)
        + np.round(t_off * 1000).astype(np.int64)
    )
    # Keep strictly increasing timestamps (multiple ticks in one ms are fine,
    # but sorting makes downstream pointer logic trivial).
    t_ms = np.maximum.accumulate(t_ms)

    open_px = open_price(instr, day)
    next_open = open_price(instr, day + timedelta(days=1))

    # Brownian bridge from open to next open, with session-shaped volatility.
    frac = t_off / duration_s
    dt = np.diff(t_off, prepend=0.0)
    vol_shape = np.interp(t_off, offset_grid, act_grid)
    sigma = instr.daily_vol * np.sqrt(np.maximum(dt, 1e-6) / duration_s) * vol_shape
    steps = rng.normal(0.0, 1.0, size=t_off.size) * sigma * open_px
    walk = np.cumsum(steps)
    bridge = walk - frac * walk[-1]
    scale = (instr.daily_vol * open_px) / (np.std(bridge) + 1e-12)
    bridge = bridge * scale

    drift = open_px + (next_open - open_px) * frac
    price = drift + bridge

    # Microstructure: price is quoted in discrete increments.
    tick_size = 10.0 ** (-instr.digits)
    price = np.round(price / tick_size) * tick_size
    price = np.maximum(price, tick_size)

    size = rng.lognormal(mean=np.log(0.35), sigma=0.9, size=t_off.size)
    # Occasional block prints.
    blocks = rng.random(size=size.size) < 0.006
    size[blocks] *= rng.uniform(8.0, 40.0, size=blocks.sum())

    return {
        "t": t_ms.astype(np.int64),
        "p": price.astype(np.float64),
        "s": np.round(size, 4),
    }


def day_bounds_utc(day: date, instr: Instrument) -> tuple[int, int]:
    start_h, end_h = session_bounds(instr)
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(hours=start_h)
    end = datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(hours=end_h)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def is_trading_day(symbol: str, day: date) -> bool:
    """Weekend handling. FX closes Friday evening and reopens Sunday evening;
    the synthetic feed models the closed window as a full Sat/Sun gap."""
    instr = INSTRUMENTS[symbol]
    if instr.kind == "fx":
        return day.weekday() < 5
    if instr.kind in {"stock", "metal"}:
        return day.weekday() < 5
    return True


__all__ = [
    "generate_ticks",
    "open_price",
    "day_bounds_utc",
    "is_trading_day",
    "EPOCH",
    "_DAY_MS",
]
