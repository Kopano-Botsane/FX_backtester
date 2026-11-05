"""Tests for the binary tick frames on /ws/replay."""

from __future__ import annotations

import struct

import numpy as np

from app import main as app_main
from app.store import Ticks


def _ticks(*rows: tuple[int, float, float]) -> Ticks:
    t = np.array([r[0] for r in rows], dtype=np.int64)
    p = np.array([r[1] for r in rows], dtype=np.float64)
    s = np.array([r[2] for r in rows], dtype=np.float64)
    return Ticks(t, p, s)


def test_encode_binary_layout():
    frame = app_main.encode_binary(_ticks((1767600000123, 1.5, 2.5)), app_main.KIND_HISTORY, 1767600000999)
    assert len(frame) == 16 + 24
    kind, count, when = struct.unpack("<B3xId", frame[:16])
    assert (kind, count, when) == (app_main.KIND_HISTORY, 1, 1767600000999.0)
    t, p, s = struct.unpack("<3d", frame[16:])
    assert (t, p, s) == (1767600000123.0, 1.5, 2.5)


def test_decode_binary_roundtrip():
    """decodeTickFrame's contract: little-endian f64 columns at offsets 16/24/32."""
    batch = _ticks((123, 4.5, 0.75), (456, 5.5, 1.75), (789, -0.5, 0.0))
    frame = app_main.encode_binary(batch, app_main.KIND_TICKS, 900)
    view = memoryview(frame)
    kind = view[0]
    count = struct.unpack_from("<I", frame, 4)[0]
    times = np.frombuffer(frame, dtype="<f8", count=count, offset=16)
    prices = np.frombuffer(frame, dtype="<f8", count=count, offset=16 + count * 8)
    sizes = np.frombuffer(frame, dtype="<f8", count=count, offset=16 + count * 16)
    assert kind == app_main.KIND_TICKS and count == 3
    assert times.tolist() == [123.0, 456.0, 789.0]
    assert prices.tolist() == batch.p.tolist()
    assert sizes.tolist() == [0.75, 1.75, 0.0]


def test_encode_binary_empty():
    frame = app_main.encode_binary(_ticks(), app_main.KIND_TICKS, 42)
    assert len(frame) == 16
    kind, count, when = struct.unpack("<B3xId", frame)
    assert (kind, count, when) == (app_main.KIND_TICKS, 0, 42.0)
