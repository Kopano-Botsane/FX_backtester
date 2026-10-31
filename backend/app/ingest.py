"""Dukascopy ingestion.

Dukascopy publishes one LZMA-compressed ``.bi5`` file per instrument/hour. Each
record is 20 bytes, big-endian::

    uint32 ms_into_hour, uint32 ask, uint32 bid, float32 ask_volume, float32 bid_volume

Prices are integers scaled by 10**digits (1e-5 for EURUSD, 1e-3 for USDJPY).

This module decodes those files and writes them into the CSV store the replay
server already understands. It is optional: the app ships with a synthetic feed
so it works offline.

Usage::

    python -m app.ingest EURUSD 2026-03-17
    python -m app.ingest EURUSD 2026-03-17 --hours 8-16
"""

from __future__ import annotations

import argparse
import csv
import gzip
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from .config import DATA_DIR, INSTRUMENTS, Instrument
from .store import Ticks
from . import synth

BASE_URL = "https://datafeed.dukascopy.com/datafeed"
RECORD = struct.Struct(">IIIff")
RECORD_DTYPE = np.dtype([
    ("ms", ">u4"),
    ("ask", ">u4"),
    ("bid", ">u4"),
    ("ask_volume", ">f4"),
    ("bid_volume", ">f4"),
])

# Instruments exposed by Dukascopy's tick feed under the same ticker.
DUKASCOPY_SYMBOLS = {"EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCHF", "XAUUSD"}

# Dukascopy's edge rejects non-browser clients with HTTP 503, so we default to
# a standard browser User-Agent. Override with BT_DUKA_UA if it changes again.
USER_AGENT = os.environ.get(
    "BT_DUKA_UA",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36",
)


class IngestError(RuntimeError):
    pass


def decode_bi5(raw: bytes, hour_start_ms: int, point: float) -> Ticks:
    """Decode one hourly ``.bi5`` payload into ticks (bid price / bid volume)."""
    if not raw:
        empty = np.empty(0)
        return Ticks(empty.astype(np.int64), empty, empty)
    data = lzma.decompress(raw)
    if len(data) % RECORD.size:
        raise IngestError(f"truncated bi5 payload ({len(data)} bytes)")
    records = np.frombuffer(data, dtype=RECORD_DTYPE)
    t = hour_start_ms + records["ms"].astype(np.int64)
    p = records["bid"].astype(np.float64) * point
    v = records["bid_volume"].astype(np.float64)
    return Ticks(t, p, v)


def hour_url(symbol: str, hour: datetime) -> str:
    # Dukascopy's path month is zero-based: 00 = January.
    return (
        f"{BASE_URL}/{symbol}/{hour.year}/{hour.month - 1:02d}/"
        f"{hour.day:02d}/{hour.hour:02d}h_ticks.bi5"
    )


def fetch_hour(symbol: str, hour: datetime, point: float, retries: int = 6,
               timeout: float = 60.0) -> Ticks:
    """Fetch one hour of ticks.

    Dukascopy's edge is aggressively rate-limited (answers arrived every
    20-35 s in testing, with intermittent 503s), so keep concurrency low and
    back off exponentially: 2, 5, 10, 20, 30, 45 s.
    """
    url = hour_url(symbol, hour)
    backoff = [2, 5, 10, 20, 30, 45]
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
            return decode_bi5(raw, int(hour.timestamp() * 1000), point)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return decode_bi5(b"", 0, point)
            last_error = exc
        except (urllib.error.URLError, TimeoutError, lzma.LZMAError) as exc:
            last_error = exc
        if attempt < retries - 1:
            time.sleep(backoff[min(attempt, len(backoff) - 1)])
    raise IngestError(f"{url}: {last_error}")


def download_day(
    symbol: str,
    day: date,
    hours: range | None = None,
    workers: int = 1,
) -> Ticks:
    symbol = symbol.upper()
    if symbol not in DUKASCOPY_SYMBOLS:
        raise IngestError(
            f"{symbol} is not mapped to a Dukascopy feed; add it to DUKASCOPY_SYMBOLS "
            "and verify the ticker on datafeed.dukascopy.com"
        )
    instr = INSTRUMENTS[symbol]
    if not synth.is_trading_day(symbol, day):
        return decode_bi5(b"", 0, 0)

    point = 10.0 ** (-instr.digits)
    session_start, session_end = synth.day_bounds_utc(day, instr)
    day_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    wanted = hours if hours is not None else range(24)

    chunks: list[Ticks] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(fetch_hour, symbol, day_start + timedelta(hours=h), point)
            for h in wanted
        ]
        for future in futures:
            chunk = future.result()
            if len(chunk):
                chunks.append(chunk)

    if not chunks:
        return decode_bi5(b"", 0, 0)

    t = np.concatenate([c.t for c in chunks])
    p = np.concatenate([c.p for c in chunks])
    v = np.concatenate([c.s for c in chunks])
    order = np.argsort(t, kind="stable")
    t, p, v = t[order], p[order], v[order]
    keep = (t >= session_start) & (t <= session_end) & (p > 0)
    return Ticks(t[keep], p[keep], v[keep])


def write_csv(symbol: str, day: date, ticks: Ticks, data_dir: Path = DATA_DIR) -> Path:
    path = data_dir / "ticks" / symbol / f"{day.isoformat()}.csv.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.gz")
    with gzip.open(tmp, "wt", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["timestamp", "price", "size"])
        for i in range(len(ticks)):
            writer.writerow([int(ticks.t[i]), f"{ticks.p[i]:.10f}", f"{ticks.s[i]:.4f}"])
    tmp.replace(path)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download Dukascopy ticks into the local CSV store")
    parser.add_argument("symbol")
    parser.add_argument("day", help="YYYY-MM-DD (UTC)")
    parser.add_argument("--hours", help="hour range, e.g. 8-16 (UTC)", default=None)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args(argv)

    symbol = args.symbol.upper()
    if symbol not in INSTRUMENTS:
        print(f"unknown symbol {symbol}", file=sys.stderr)
        return 2
    day = date.fromisoformat(args.day)

    hours = None
    if args.hours:
        lo, _, hi = args.hours.partition("-")
        hours = range(int(lo), int(hi) + 1)

    print(f"fetching {symbol} {day} ...", file=sys.stderr)
    ticks = download_day(symbol, day, hours=hours, workers=args.workers)
    if len(ticks) == 0:
        print("no ticks returned (market closed or wrong ticker)", file=sys.stderr)
        return 1
    path = write_csv(symbol, day, ticks)
    print(f"wrote {len(ticks):,} ticks -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
