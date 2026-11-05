"""Tick & bar storage layer.

The MVP ships with a disk-cached synthetic feed and a CSV reader for real
exports. Both satisfy the same :class:`TickStore` interface, so swapping in a
TimescaleDB/ClickHouse-backed implementation later is a drop-in change.

Bar CSVs (OHLCV) are written alongside tick CSVs during MT5 import for fast
prehistory loading. Bar files live under ``backend/data/bars/<SYMBOL>/<TF>/<YYYY-MM-DD>.csv.gz``.
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
class Bars:
    """Columnar bar batch. Sorted ascending by ``t`` (epoch milliseconds, bar open time)."""
    t: np.ndarray      # int64   bar open time (ms)
    o: np.ndarray      # float64 open
    h: np.ndarray      # float64 high
    l: np.ndarray      # float64 low
    c: np.ndarray      # float64 close
    v: np.ndarray      # float64 volume (sum of tick sizes)

    def __len__(self) -> int:
        return int(self.t.size)

    def slice(self, start: int, stop: int) -> "Bars":
        return Bars(self.t[start:stop], self.o[start:stop], self.h[start:stop],
                    self.l[start:stop], self.c[start:stop], self.v[start:stop])


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


# Supported timeframes for pre-aggregated bars
BAR_TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d")
TF_TO_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def aggregate_to_tf(ticks: Ticks, tf: str) -> Bars:
    """Vectorized tick -> OHLCV aggregation for a single timeframe.

    Uses numpy searchsorted on bucket boundaries; no Python loops.
    """
    if len(ticks) == 0:
        empty = np.empty(0)
        return Bars(empty.astype(np.int64), empty, empty, empty, empty, empty)

    ms = TF_TO_MS[tf]
    # Bucket start times (floor to TF boundary)
    bucket_start = (ticks.t // ms) * ms
    # Unique buckets and their indices
    uniq, first_idx = np.unique(bucket_start, return_index=True)
    # Append sentinel for the last bucket
    idx = np.append(first_idx, len(ticks.t))

    o = ticks.p[first_idx]
    c = ticks.p[idx[1:] - 1]
    # High/low/volume per bucket via reduceat (handle single-tick buckets)
    h = np.maximum.reduceat(ticks.p, first_idx)[:-1]
    l = np.minimum.reduceat(ticks.p, first_idx)[:-1]
    v = np.add.reduceat(ticks.s, first_idx)[:-1]

    # Ensure all arrays have the same length (reduceat edge case with single-element buckets)
    n = len(uniq)
    if len(h) != n:
        # Fallback: compute per-bucket using a loop for the problematic buckets
        h = np.empty(n, dtype=np.float64)
        l = np.empty(n, dtype=np.float64)
        v = np.empty(n, dtype=np.float64)
        for i in range(n):
            start = first_idx[i]
            end = idx[i + 1]
            bucket_prices = ticks.p[start:end]
            bucket_sizes = ticks.s[start:end]
            h[i] = float(np.max(bucket_prices))
            l[i] = float(np.min(bucket_prices))
            v[i] = float(np.sum(bucket_sizes))

    return Bars(uniq.astype(np.int64), o, h, l, c, v)


def write_bars_csv(path: Path, bars: Bars) -> None:
    """Write bars to compressed CSV: t,o,h,l,c,v (t = epoch ms)."""
    if len(bars) == 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.csv.gz")
    opener = gzip.open
    with opener(tmp, "wt", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["t", "o", "h", "l", "c", "v"])
        for i in range(len(bars)):
            writer.writerow([
                int(bars.t[i]),
                float(bars.o[i]),
                float(bars.h[i]),
                float(bars.l[i]),
                float(bars.c[i]),
                float(bars.v[i]),
            ])
    tmp.replace(path)


def read_bars_csv(path: Path) -> Bars:
    """Read bars from compressed CSV."""
    opener = gzip.open if path.suffix == ".gz" else open
    ts, os_, hs, ls, cs, vs = [], [], [], [], [], []
    with opener(path, "rt", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                ts.append(int(row["t"]))
                os_.append(float(row["o"]))
                hs.append(float(row["h"]))
                ls.append(float(row["l"]))
                cs.append(float(row["c"]))
                vs.append(float(row["v"]))
            except (ValueError, KeyError):
                continue
    if not ts:
        empty = np.empty(0)
        return Bars(empty.astype(np.int64), empty, empty, empty, empty, empty)
    return Bars(
        np.asarray(ts, dtype=np.int64),
        np.asarray(os_, dtype=np.float64),
        np.asarray(hs, dtype=np.float64),
        np.asarray(ls, dtype=np.float64),
        np.asarray(cs, dtype=np.float64),
        np.asarray(vs, dtype=np.float64),
    )


class BarStore(Protocol):
    def load(self, symbol: str, tf: str, day: date) -> Bars: ...
    def path_for(self, symbol: str, tf: str, day: date) -> Path | None: ...


class CsvBarStore:
    """Reads pre-aggregated bars from ``backend/data/bars/<SYMBOL>/<TF>/<YYYY-MM-DD>.csv[.gz]``."""

    def __init__(self, data_dir: Path = DATA_DIR) -> None:
        self.data_dir = data_dir

    def path_for(self, symbol: str, tf: str, day: date) -> Path | None:
        if tf not in TF_TO_MS:
            return None
        base = self.data_dir / "bars" / symbol / tf
        for name in (f"{day.isoformat()}.csv", f"{day.isoformat()}.csv.gz"):
            candidate = base / name
            if candidate.exists():
                return candidate
        return None

    def load(self, symbol: str, tf: str, day: date) -> Bars | None:
        path = self.path_for(symbol, tf, day)
        if path is None:
            return None
        return read_bars_csv(path)


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
        ticks = Ticks(t[order], np.asarray(px, dtype=np.float64)[order],
                     np.asarray(sz, dtype=np.float64)[order])

        # Lazily generate & cache bar CSVs for fast prehistory loading
        self._ensure_bars_for_day(symbol, day, ticks)
        return ticks

    def _ensure_bars_for_day(self, symbol: str, day: date, ticks: Ticks) -> None:
        """Generate bar CSVs for all timeframes if they don't exist."""
        for tf in BAR_TIMEFRAMES:
            bar_path = self.data_dir / "bars" / symbol / tf / f"{day.isoformat()}.csv.gz"
            if bar_path.exists():
                continue
            bars = aggregate_to_tf(ticks, tf)
            if len(bars) > 0:
                write_bars_csv(bar_path, bars)


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
        self.bars = CsvBarStore()
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

    def session_days(self, symbol: str) -> list[date]:
        """Days a backtest session may span: real exports when the symbol has
        any (synthetic data never mixes into a real tape), otherwise the
        synthetic in-fill list."""
        all_days = self.available_days(symbol)
        real = [d for d in all_days if self.csv.path_for(symbol, d)]
        return sorted(real or all_days, reverse=True)

    def days_for_range(
        self,
        symbol: str,
        start: date,
        end: date | None = None,
        history_days: int = 0,
    ) -> list[date]:
        """Resolve a session into a day list: ``history_days`` sessions before
        ``start`` plus every day through ``end`` (default: the latest).

        Integrity rule: if the symbol has *any* real export files, a session
        uses only real days — the synthetic generator never contaminates a
        real tape (export gaps simply produce a time jump). Symbols with no
        real data keep the synthetic in-fill behaviour.

        Raises KeyError when there is no data on the start date."""
        asc = sorted(self.session_days(symbol))
        if start not in asc:
            raise KeyError(start.isoformat())
        last = asc[-1]
        stop = min(end, last) if end is not None and end <= last else (end if end is not None else last)
        forward = [d for d in asc if start <= d <= stop]
        back = [d for d in asc if d < start][-max(history_days, 0):]
        return back + forward

    def load_days(self, symbol: str, days: list[date]) -> Ticks:
        """Concatenate the given days into one ascending tape."""
        if not days:
            raise ValueError("no days")
        parts = [self.load(symbol, d) for d in days]
        if len(parts) == 1:
            return parts[0]
        return Ticks(
            np.concatenate([p.t for p in parts]),
            np.concatenate([p.p for p in parts]),
            np.concatenate([p.s for p in parts]),
        )

    def load_bars(self, symbol: str, tf: str, days: list[date]) -> Bars:
        """Concatenate pre-aggregated bars for the given days."""
        if not days:
            raise ValueError("no days")
        if tf not in TF_TO_MS:
            raise ValueError(f"unsupported timeframe: {tf}")
        parts = []
        for d in days:
            bars = self.bars.load(symbol, tf, d)
            if bars is None or len(bars) == 0:
                # Fall back to synthetic ticks and aggregate on the fly
                ticks = self.synthetic.load(symbol, d)
                if len(ticks) > 0:
                    bars = aggregate_to_tf(ticks, tf)
            if bars is not None and len(bars) > 0:
                parts.append(bars)
        if not parts:
            empty = np.empty(0)
            return Bars(empty.astype(np.int64), empty, empty, empty, empty, empty)
        if len(parts) == 1:
            return parts[0]
        return Bars(
            np.concatenate([p.t for p in parts]),
            np.concatenate([p.o for p in parts]),
            np.concatenate([p.h for p in parts]),
            np.concatenate([p.l for p in parts]),
            np.concatenate([p.c for p in parts]),
            np.concatenate([p.v for p in parts]),
        )


def default_start_ms(symbol: str, day: date) -> int:
    """Start replay ~35% into the session so the chart opens with history.

    Used by tests and ad-hoc drills; the app now starts sessions at the
    session open of the chosen start day."""
    instr = INSTRUMENTS[symbol]
    start, end = synth.day_bounds_utc(day, instr)
    offset = round((end - start) * 0.35 / 60_000) * 60_000
    return start + offset


__all__ = [
    "Ticks",
    "Bars",
    "TickStore",
    "BarStore",
    "SyntheticTickStore",
    "CsvTickStore",
    "CsvBarStore",
    "CompositeStore",
    "aggregate_to_tf",
    "write_bars_csv",
    "read_bars_csv",
    "BAR_TIMEFRAMES",
    "TF_TO_MS",
    "default_start_ms",
]
