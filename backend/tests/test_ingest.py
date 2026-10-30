import gzip
import lzma
import struct
from datetime import date, datetime, timezone

import numpy as np

from app.ingest import decode_bi5, hour_url, write_csv
from app.store import CsvTickStore


def test_decode_bi5_roundtrip():
    hour = datetime(2026, 3, 17, 9, tzinfo=timezone.utc)
    start = int(hour.timestamp() * 1000)
    rec = struct.Struct(">IIIff")
    payload = b"".join([
        rec.pack(0, 108500, 108495, 1.5, 2.5),
        rec.pack(830, 108510, 108505, 0.5, 1.0),
        rec.pack(20_000, 108520, 108515, 3.0, 3.0),
    ])
    ticks = decode_bi5(lzma.compress(payload), start, 1e-5)

    assert len(ticks) == 3
    assert ticks.t.tolist() == [start, start + 830, start + 20_000]
    assert np.allclose(ticks.p, [1.08495, 1.08505, 1.08515])
    assert np.allclose(ticks.s, [2.5, 1.0, 3.0])


def test_decode_empty():
    ticks = decode_bi5(b"", 0, 1e-5)
    assert len(ticks) == 0


def test_hour_url_uses_zero_based_month():
    hour = datetime(2026, 1, 5, 13, tzinfo=timezone.utc)
    assert hour_url("EURUSD", hour).endswith("EURUSD/2026/00/05/13h_ticks.bi5")


def test_csv_store_reads_written_file(tmp_path):
    from app.store import Ticks

    day = date(2026, 3, 17)
    t = np.array([1_773_000_000_000, 1_773_000_000_500], dtype=np.int64)
    ticks = Ticks(t, np.array([1.085, 1.0851]), np.array([1.0, 2.0]))
    write_csv("EURUSD", day, ticks, data_dir=tmp_path)

    store = CsvTickStore(tmp_path)
    loaded = store.load("EURUSD", day)
    assert loaded is not None
    assert np.array_equal(loaded.t, t)
    assert np.allclose(loaded.p, ticks.p)


def test_written_csv_is_gzip(tmp_path):
    from app.store import Ticks

    ticks = Ticks(np.array([1], dtype=np.int64), np.array([1.0]), np.array([1.0]))
    path = write_csv("EURUSD", date(2026, 3, 17), ticks, data_dir=tmp_path)
    with gzip.open(path, "rt") as fh:
        assert fh.readline().strip() == "timestamp,price,size"
