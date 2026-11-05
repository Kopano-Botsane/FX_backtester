"""Static configuration: instruments, replay speeds and chart timeframes."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_dir(name: str, default: Path) -> Path:
    """Directory from an env var (Electron points these at userData when frozen)."""
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw else default


# Repository root (backend/app/config.py -> ../../)
ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = _env_dir("BT_DATA_DIR", Path(__file__).resolve().parents[1] / "data")
CACHE_DIR = _env_dir("BT_CACHE_DIR", Path(__file__).resolve().parents[1] / ".cache")

# A symbol's intrabar volatility scale, used by the synthetic generator and by
# the price formatting on the client.
@dataclass(frozen=True)
class Instrument:
    symbol: str
    name: str
    kind: str  # "fx" | "stock" | "metal"
    base_price: float
    digits: int
    daily_vol: float  # relative vol of one trading day
    tick_interval_s: float
    session: tuple[float, float] | None = None  # UTC hours, None = 24h


INSTRUMENTS: dict[str, Instrument] = {
    "EURUSD": Instrument("EURUSD", "Euro / US Dollar", "fx", 1.0850, 5, 0.0055, 0.9),
    "GBPUSD": Instrument("GBPUSD", "British Pound / US Dollar", "fx", 1.2700, 5, 0.0065, 1.0),
    "USDJPY": Instrument("USDJPY", "US Dollar / Japanese Yen", "fx", 151.20, 3, 0.0060, 1.0),
    "AUDUSD": Instrument("AUDUSD", "Australian Dollar / US Dollar", "fx", 0.6580, 5, 0.0070, 1.4),
    "USDCHF": Instrument("USDCHF", "US Dollar / Swiss Franc", "fx", 0.8950, 5, 0.0050, 1.3),
    "XAUUSD": Instrument("XAUUSD", "Gold / US Dollar", "metal", 2330.00, 2, 0.0100, 0.7),
    "AAPL": Instrument("AAPL", "Apple Inc.", "stock", 225.00, 2, 0.0180, 0.8, (13.5, 20.0)),
    "TSLA": Instrument("TSLA", "Tesla Inc.", "stock", 250.00, 2, 0.0320, 0.55, (13.5, 20.0)),
    "NVDA": Instrument("NVDA", "NVIDIA Corp.", "stock", 135.00, 2, 0.0300, 0.6, (13.5, 20.0)),
}

# Replay speeds the server is allowed to pace at.
SPEEDS: tuple[float, ...] = (0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000)

# Client-supported timeframes. The server only needs them to validate requests.
TIMEFRAMES_MS: dict[str, int] = {
    "1s": 1_000,
    "5s": 5_000,
    "15s": 15_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}

# How many calendar days back the synthetic dataset can generate.
DATASET_DAYS = 45

# Replay loop cadence and max ticks per websocket frame.
FRAME_MS = 50
MAX_TICKS_PER_FRAME = 20_000

# History is streamed in batches the client aggregates per chunk. 64k ticks
# keeps the per-chunk overhead low without pulling a whole session into one
# frame or starving the event loop.
HISTORY_CHUNK = 65_536
