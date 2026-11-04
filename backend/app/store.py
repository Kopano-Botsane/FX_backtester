"""Tick storage layer.

The MVP ships with a disk-cached synthetic feed and a CSV reader for real
exports. Both satisfy the same :class:`TickStore` interface, so swapping in a
TimescaleDB/ClickHouse-backed implementation later is a drop-in change.
"""

from __future__ import annotations

import csv
import gzip
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

import numpy as np

from .config import CACHE_DIR, DATA_DIR, DATASET_DAYS, INSTRUMENTS
from . import synth


@dataclass(frozen=True)
class Ticks:
    """Columnar tick batch. Sorted ascending by ``t`` (epoch milliseconds)."""

    t: np.ndarray
    p: np.ndarray
    s: np.ndarray

    def __len__(self) -> int:
        return int(self.t.size)

    def slice(self, start: int, stop: int) -> "Ticks":
        return Ticks(self.t[start:stop], self.p[start:stop], self.s[start:stop])

    def with_times_before(self, cutoff_ms: int) -> "Ticks":
        idx = int(np.searchsorted(self.t, cutoff_ms, side="left"))
        return self.slice(0, idx)


class TickStore(Protocol):
    def load(self, symbol: str, day: date) -> Ticks: ...


class SyntheticTickStore:
    """Generates deterministic ticks and caches them as compressed npz."""

    def __init__(self, cache_dir: Path = CACHE_DIR) -> None:
        self.cache_dir = cache_dir

    def _cache_path(self, symbol: str, day: date) -> Path:
        # Bump the suffix whenever the generator changes so stale tapes are not
        # silently reused after an upgrade.
        return self.cache_dir / "ticks" / symbol / f"{day.isoformat()}.v2.npz"

    def load(self, symbol: str, day: date) -> Ticks:
        if symbol not in INSTRUMENTS:
            raise KeyError(f"unknown symbol: {symbol}")
        if not synth.is_trading_day(symbol, day):
            empty = np.empty(0)
            return Ticks(empty.astype(np.int64), empty, empty)

        path = self._cache_path(symbol, day)
        if path.exists():
            with np.load(path) as data:
                return Ticks(data["t"], data["p"], data["s"])

        raw = synth.generate_ticks(symbol, day)
        ticks = Ticks(raw["t"], raw["p"], raw["s"])
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez(tmp, t=ticks.t, p=ticks.p, s=ticks.s)
        tmp.replace(path)
        return ticks


class CsvTickStore:
    """Reads real exports from ``backend/data/ticks/<SYMBOL>/<YYYY-MM-DD>.csv[.gz]``.

    Accepted header: ``timestamp,price,size`` where timestamp is epoch ms or an
    ISO-8601 UTC string.
    """

    def __init__(self, data_dir: Path = DATA_DIR) -> None:
        self.data_dir = data_dir

    def path_for(self, symbol: str, day: date) -> Path | None:
        base = self.data_dir / "ticks" / symbol
        for name in (f"{day.isoformat()}.csv", f"{day.isoformat()}.csv.gz"):
            candidate = base / name
            if candidate.exists():
                return candidate
        return None

    def load(self, symbol: str, day: date) -> Ticks | None:
        path = self.path_for(symbol, day)
        if path is None:
            return None
        opener = gzip.open if path.suffix == ".gz" else open
        ts: list[int] = []
        px: list[float] = []
        sz: list[float] = []
        with opener(path, "rt", newline="") as fh:  # type: ignore[operator]
            reader = csv.DictReader(fh)
            for row in reader:
                try:
                    ts.append(_parse_ts(row["timestamp"]))
                    px.append(float(row["price"]))
                    sz.append(float(row.get("size") or 1.0))
                except (ValueError, TypeError, KeyError):
                    continue  # skip blank/junk rows
        t = np.asarray(ts, dtype=np.int64)
        order = np.argsort(t, kind="stable")
        return Ticks(t[order], np.asarray(px, dtype=np.float64)[order],
                     np.asarray(sz, dtype=np.float64)[order])


def _parse_ts(value: str) -> int:
    value = value.strip()
    if value.isdigit():
        n = int(value)
        return n if n > 10**11 else n * 1000
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


class CompositeStore:
    """Prefer real CSV exports, fall back to the synthetic generator."""

    def __init__(self) -> None:
        self.csv = CsvTickStore()
        self.synthetic = SyntheticTickStore()

    def load(self, symbol: str, day: date) -> Ticks:
        real = self.csv.load(symbol, day)
        if real is not None and len(real) > 0:
            return real
        return self.synthetic.load(symbol, day)

    def available_days(self, symbol: str) -> list[date]:
        days: set[date] = set()
        # Real MT5 exports first, then the synthetic dataset in-filled
        # with recent sessions.
        data_dir = self.csv.data_dir / "ticks" / symbol
        if data_dir.is_dir():
            for path in data_dir.iterdir():
                name = path.name
                if name.endswith(".gz"):
                    name = name[:-3]
                if name.endswith(".csv"):
                    name = name[:-4]
                try:
                    days.add(date.fromisoformat(name))
                except ValueError:
                    continue  # not a day file (tmp files, etc.)
        today = datetime.now(timezone.utc).date()
        for offset in range(DATASET_DAYS):
            day = today - timedelta(days=offset)
            if not synth.is_trading_day(symbol, day):
                continue
            days.add(day)
        return sorted(days, reverse=True)

    def session(self, symbol: str, day: date) -> dict[str, int]:
        instr = INSTRUMENTS[symbol]
        start, end = synth.day_bounds_utc(day, instr)
        return {
            "start": start,
            "end": end,
            "defaultStart": default_start_ms(symbol, day),
        }


def default_start_ms(symbol: str, day: date) -> int:
    """Start replay ~35% into the session so the chart opens with history."""
    instr = INSTRUMENTS[symbol]
    start, end = synth.day_bounds_utc(day, instr)
    offset = round((end - start) * 0.35 / 60_000) * 60_000
    return start + offset


__all__ = [
    "Ticks",
    "TickStore",
    "SyntheticTickStore",
    "CsvTickStore",
    "CompositeStore",
    "default_start_ms",
]
