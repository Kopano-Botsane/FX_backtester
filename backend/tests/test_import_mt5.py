"""Tests for the MT5 tick-export importer."""

from __future__ import annotations

import csv
import gzip
from datetime import date

import pytest

from app import import_mt5
from app.config import INSTRUMENTS
from app.store import CsvTickStore

SAMPLE = """<DATE>\t<TIME>\t<BID>\t<ASK>\t<LAST>\t<VOLUME>\t<FLAGS>
2026.01.01\t23:05:00.019\t4328.340\t4328.500\t\t\t6
2026.01.01\t23:05:00.025\t4328.340\t4328.500\t\t\t6
2026.01.02\t10:00:00.000\t4300.000\t4300.200\t\t1.5\t6
2026.01.02\t10:00:01.500\t4299.990\t4300.110\t3999.00\t\t6
"""

BROKEN_HEADER = """date;time;bid
2026.01.05;10:00;3000.00
"""


def make_tree(tmp_path, body: str, folder: str = "XAUUSD_CSV",
              file: str | None = "ticks.csv"):
    root = tmp_path / "MT5_CSV"
    folder_path = root / folder
    folder_path.mkdir(parents=True)
    if file:
        (folder_path / file).write_text(body, encoding="utf-8")
    return root


def read_day_csv(data_dir, symbol, day):
    path = data_dir / "ticks" / symbol / f"{day}.csv.gz"
    with gzip.open(path, "rt") as fh:
        rows = [r for r in csv.reader(fh) if r]
    header, rows = rows[0], rows[1:]
    assert header == ["timestamp", "price", "size"]
    return [(int(t), float(p), float(s)) for t, p, s in rows]


def test_import_bid_splits_days(tmp_path):
    root = make_tree(tmp_path, SAMPLE)
    data_dir = tmp_path / "data"
    totals = import_mt5.import_symbols(data_dir, root)
    assert totals == {"XAUUSD": 4}
    rows = read_day_csv(data_dir, "XAUUSD", "2026-01-01")
    # first tick exactly as archived: 2026-01-01T23:05:00.019, bid 4328.34
    assert rows[0] == (1767308700019, 4328.34, 1.0)
    assert rows[1][0] - rows[0][0] == 6
    rows2 = read_day_csv(data_dir, "XAUUSD", "2026-01-02")
    # 10:00:00 == 2026-01-02 10:00 UTC
    assert rows2[0][0] == 1767348000000
    assert rows2[0][2] == 1.5  # VOLUME parsed into size
    # the next store can read these files directly
    store = CsvTickStore(data_dir=data_dir)
    ticks = store.load("XAUUSD", date(2026, 1, 2))
    assert len(ticks.t) == 2 and ticks.t[0] == 1767348000000


def test_import_mid_uses_half_spread(tmp_path):
    root = make_tree(tmp_path, SAMPLE)
    data_dir = tmp_path / "data"
    import_mt5.import_symbols(data_dir, root, side="mid")
    rows = read_day_csv(data_dir, "XAUUSD", "2026-01-01")
    assert rows[0][1] == pytest.approx((4328.34 + 4328.50) / 2, abs=1e-9)


def test_side_filter(tmp_path):
    root = make_tree(tmp_path, SAMPLE)
    data_dir = tmp_path / "data"
    import_mt5.import_symbols(data_dir, root, side="ask")
    rows = read_day_csv(data_dir, "XAUUSD", "2026-01-01")
    assert rows[0][1] == 4328.50


def test_start_end_dates_filter(tmp_path):
    root = make_tree(tmp_path, SAMPLE)
    data_dir = tmp_path / "data"
    import_mt5.import_symbols(
        data_dir, root, day_from=date(2026, 1, 2), day_to=date(2026, 1, 2)
    )
    path = data_dir / "ticks" / "XAUUSD"
    assert [p.name for p in path.glob("*.csv.gz")] == ["2026-01-02.csv.gz"]


def test_skips_junk_and_repeated_headers(tmp_path):
    body = SAMPLE + "<DATE>\t<TIME>\t<BID>\t<ASK>\nnot\ttabbed\n2026.01.02\t10:00:02.000\t4300.100\t4300.250\n"
    root = make_tree(tmp_path, body)
    data_dir = tmp_path / "data"
    totals = import_mt5.import_symbols(data_dir, root)
    assert totals == {"XAUUSD": 5}  # junk and header row skipped
    store = CsvTickStore(data_dir=data_dir)
    ticks = store.load("XAUUSD", date(2026, 1, 2))
    assert list(ticks.t) == [1767348000000, 1767348001500, 1767348002000]


def test_bad_header_raises(tmp_path):
    root = make_tree(tmp_path, BROKEN_HEADER)
    data_dir = tmp_path / "data"
    with pytest.raises(import_mt5.ImportMt5Error):
        import_mt5.import_symbols(data_dir, root)


def test_canonical_symbol_matches_instruments():
    assert import_mt5.canonical_symbol("XAUUSDm", INSTRUMENTS) == "XAUUSD"
    assert import_mt5.canonical_symbol("EURUSD", INSTRUMENTS) == "EURUSD"
    assert import_mt5.canonical_symbol("EURUSD.pro", INSTRUMENTS) == "EURUSD"
    # unknown ticker is used as-is rather than guessed
    assert import_mt5.canonical_symbol("ZZZ1Y", INSTRUMENTS) == "ZZZ1Y"


def test_gz_input(tmp_path):
    root = make_tree(tmp_path, SAMPLE, file=None)
    with gzip.open(root / "XAUUSD_CSV" / "ticks.csv.gz", "wt", encoding="utf-8") as fh:
        fh.write(SAMPLE)
    data_dir = tmp_path / "data"
    totals = import_mt5.import_symbols(data_dir, root)
    assert totals == {"XAUUSD": 4}
    rows = read_day_csv(data_dir, "XAUUSD", "2026-01-01")
    assert rows[0][1] == 4328.34
