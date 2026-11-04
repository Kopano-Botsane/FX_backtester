"""Import MetaTrader 5 tick exports into the local CSV store.

MT5 saves chronological tab-separated files with a first line of
``<DATE>\t<TIME>\t<BID>\t<ASK>\t<LAST>\t<VOLUME>\t<FLAGS>`` (only the tick
columns carry values; ``VOLUME`` is usually empty). Times are exported in
terminal time and are treated as UTC here, exactly as given.

The local store reads ``backend/data/ticks/<SYMBOL>/<YYYY-MM-DD>.csv.gz``
files with ``timestamp,price,size`` (epoch ms). This module makes those,
so no further wiring is needed: ``CompositeStore`` prefers them over the
synthetic tape and the day picker lists them.

Expected layout (folders end in ``_CSV``)::

    MT5_CSV/XAUUSD_CSV/XAUUSDm_202601012305_202611032358.csv
    MT5_CSV/EURUSD_CSV/*.csv

Usage (from ``backend/``)::

    python -m app.import_mt5                # every *_CSV folder
    python -m app.import_mt5 XAUUSDEURUSD   # folder symbol match
    python -m app.import_mt5 XAUUSD --side mid
    python -m app.import_mt5 EURUSD --start 2026-01-05 --end 2026-03-31
    python -m app.import_mt5 --data-dir /tmp/somewhere   # for tests
"""

from __future__ import annotations

import argparse
import gzip
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from .config import DATA_DIR, INSTRUMENTS, Instrument

DAY_MS = 86_400_000
DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "MT5_CSV"


class ImportMt5Error(RuntimeError):
    pass


def scan_folders(csv_root: Path) -> list[tuple[str, Path]]:
    """Return ``(raw_symbol, folder)`` for every ``*_CSV`` directory."""
    if not csv_root.is_dir():
        return []
    out: list[tuple[str, Path]] = []
    for entry in sorted(csv_root.iterdir()):
        if entry.is_dir() and entry.name.upper().endswith("_CSV"):
            out.append((entry.name.upper()[:-4], entry))
    return out


def canonical_symbol(raw: str, instrs: dict[str, Instrument]) -> str:
    """``XAUUSDm`` -> ``XAUUSD`` if a known instrument matches, else raw."""
    up = raw.upper()
    if up in instrs:
        return up
    best = ""
    for base in instrs:
        if up.startswith(base) and len(base) > len(best) and len(up) > len(base):
            best = base
    return best or up


def _source_stream(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def _to_epoch_ms(day_text: str, time_text: str, cache: dict[str, int]) -> int:
    """``2026.01.01`` + ``23:05:00.019`` → epoch ms, taken literally as UTC."""
    base = cache.get(day_text)
    if base is None:
        year, month, day = day_text.split(".")
        base = int(
            datetime(int(year), int(month), int(day), tzinfo=timezone.utc)
            .timestamp() * 1000
        )
        cache[day_text] = base
    hh, mm, ss = time_text.split(":")
    if "." in ss:
        sec, ms_text = ss.split(".")
        ms = int(ms_text[:3].ljust(3, "0"))
    else:
        sec, ms = ss, 0
    return base + int(hh) * 3_600_000 + int(mm) * 60_000 + int(sec) * 1000 + ms


def _find(names: list[str], name: str) -> int | None:
    for i, n in enumerate(names):
        if n == name:
            return i
    return None


def _column_map(header_line: str) -> dict[str, int]:
    names = [c.strip().strip("<>").strip().upper()
             for c in header_line.replace(",", "\t").split("\t")]
    if _find(names, "DATE") is None or _find(names, "TIME") is None:
        raise ImportMt5Error(f"header has no DATE/TIME columns: {header_line!r}")
    parts = {"DATE": _find(names, "DATE"), "TIME": _find(names, "TIME"),
             "BID": _find(names, "BID"), "ASK": _find(names, "ASK"),
             "VOLUME": _find(names, "VOLUME")}
    if parts["BID"] is None and parts["ASK"] is None:
        raise ImportMt5Error(f"header has no BID/ASK columns: {header_line!r}")
    return parts


def _price_fields(cols: dict[str, int], side: str) -> tuple[int, int | None]:
    if side == "mid":
        bid, ask = cols.get("BID"), cols.get("ASK")
        if bid is None or ask is None:
            raise ImportMt5Error("--side mid needs both BID and ASK columns")
        return bid, ask
    primary = cols.get("BID" if side == "bid" else "ASK")
    if primary is None:
        primary = cols.get("BID", cols.get("ASK"))
    return primary, None


def import_symbols(
    data_dir: Path,
    csv_root: Path,
    symbols: list[str] | None = None,
    side: str = "bid",
    day_from: date | None = None,
    day_to: date | None = None,
) -> dict[str, int]:
    """Import every matching folder; return {canonical_symbol: ticks_written}."""
    folders = scan_folders(csv_root)
    wanted = {s.upper() for s in symbols} if symbols else None
    totals: dict[str, int] = {}
    for raw, folder in folders:
        canonical = canonical_symbol(raw, INSTRUMENTS)
        if wanted and canonical not in wanted and raw not in wanted:
            continue
        files = [f for f in sorted(folder.iterdir())
                 if f.is_file() and f.suffix.lower() in (".csv", ".txt", ".gz")]
        if not files:
            print(f"[{raw}] no tick files in {folder}", flush=True)
            continue
        count = import_files(
            files, canonical, data_dir,
            side=side, day_from=day_from, day_to=day_to, label=raw,
        )
        totals[canonical] = count
    return totals


def import_files(
    files: list[Path],
    symbol: str,
    data_dir: Path,
    side: str = "bid",
    day_from: date | None = None,
    day_to: date | None = None,
    label: str | None = None,
) -> int:
    """Stream files (chronological) into per-day store CSVs. Returns tick count."""
    out_dir = data_dir / "ticks" / symbol
    writers: dict[str, "gzip.GzipFile"] = {}
    total_written = 0
    try:
        for path in files:
            print(f"[{label or symbol}] {path.name}: importing ...", flush=True)
            total_written += _convert_file(
                path, symbol, out_dir, writers,
                side=side, day_from=day_from, day_to=day_to,
            )
    finally:
        for gz in writers.values():
            gz.close()
        writers.clear()
    days = sorted(day for day in (
        p.name.removesuffix(".gz").removesuffix(".csv") for p in out_dir.glob("*.csv.gz")
    ))
    print(f"[{label or symbol}] done: {total_written:,} ticks, "
          f"{len(days)} day files -> {out_dir}", flush=True)
    return total_written


def _convert_file(
    path: Path,
    symbol: str,
    out_dir: Path,
    writers: dict[str, "gzip.GzipFile"],
    side: str,
    day_from: date | None,
    day_to: date | None,
) -> int:
    count = 0
    day_cache: dict[str, int] = {}
    lo_ms = -1 if day_from is None else _from_date_ms(day_from)
    hi_ms = (1 << 62) if day_to is None else (_from_date_ms(day_to) + DAY_MS)
    with _source_stream(path) as fh:
        header = fh.readline()
        if not header.strip():
            return 0
        cols = _column_map(header)
        price_i, other_i = _price_fields(cols, side)
        date_i, time_i = cols["DATE"], cols["TIME"]
        vol_i = cols.get("VOLUME")
        last_seen_day = ""
        for line in fh:
            if not line or line.startswith("<"):  # stray/repeated header
                continue
            items = line.rstrip("\n").split("\t")
            try:
                price_text = items[price_i]
                time_text = items[time_i]
                if not price_text or not time_text:
                    continue
                ts = _to_epoch_ms(items[date_i], time_text, day_cache)
            except (IndexError, ValueError):
                continue  # trailing junk / footer lines
            if ts < lo_ms or ts >= hi_ms:
                continue
            if side == "mid":
                other = items[other_i]
                if not other:
                    continue
                lo, hi = float(price_text), float(other)
                price_text = f"{(lo + hi) / 2:.{max(1, len(price_text.split('.')[-1]))}f}"
            try:
                vol_text = items[vol_i] if vol_i is not None and vol_i < len(items) else ""
                size = float(vol_text) if vol_text else 1.0
            except (ValueError, IndexError):
                size = 1.0
            day_ms = ts // DAY_MS * DAY_MS
            key = str(day_ms)
            gz = writers.get(key)
            if gz is None:
                day = datetime.fromtimestamp(day_ms / 1000, tz=timezone.utc).date()
                out_dir.mkdir(parents=True, exist_ok=True)
                out_path = out_dir / f"{day.isoformat()}.csv.gz"
                gz = writers[key] = gzip.open(
                    out_path, "at", encoding="utf-8", compresslevel=1,
                )
                if out_path.stat().st_size == 0:  # fresh file: column header
                    gz.write("timestamp,price,size\n")
                day_iso = day.isoformat()
                if day_iso != last_seen_day:
                    last_seen_day = day_iso
                    print(f"  {day_iso}", flush=True)
            gz.write(f"{ts},{price_text},{size}\n")
            count += 1
    return count


def _from_date_ms(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import MT5 tick exports")
    parser.add_argument("symbols", nargs="*", help="symbols/folder bases, empty = all")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--side", choices=("bid", "ask", "mid"), default="bid")
    parser.add_argument("--start", help="inclusive YYYY-MM-DD")
    parser.add_argument("--end", help="inclusive YYYY-MM-DD")
    args = parser.parse_args(argv)
    if not args.root.is_dir():
        print(f"no MT5_CSV folder at {args.root}", file=sys.stderr)
        return 1
    from_dt = date.fromisoformat(args.start) if args.start else None
    to_dt = date.fromisoformat(args.end) if args.end else None
    totals = import_symbols(
        args.data_dir, args.root,
        symbols=args.symbols or None, side=args.side,
        day_from=from_dt, day_to=to_dt,
    )
    for symbol, count in totals.items():
        print(f"{symbol}: {count:,} ticks imported")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
