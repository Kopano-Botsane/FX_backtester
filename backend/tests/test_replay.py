import numpy as np

from app.replay import ReplayEngine
from app.store import Ticks


def make_ticks(n: int = 100, step_ms: int = 1000) -> Ticks:
    t = np.arange(n, dtype=np.int64) * step_ms
    p = 1.0 + np.arange(n) * 1e-5
    s = np.ones(n)
    return Ticks(t, p, s)


def test_advance_moves_clock_and_returns_slice():
    engine = ReplayEngine(make_ticks(), start_ms=0, speed=10.0)
    batch = engine.advance(100)  # 100ms wall * 10 = 1s virtual
    assert len(batch) == 2  # t=0 and t=1000 (inclusive)
    assert engine.time == 1000
    assert engine.ptr == 2


def test_advance_is_monotonic_and_eventually_ends():
    engine = ReplayEngine(make_ticks(10), start_ms=0, speed=1000.0)
    seen = 0
    for _ in range(100):
        seen += len(engine.advance(50))
    assert seen == 10
    assert engine.ended
    assert engine.time == engine.end
    assert len(engine.advance(50)) == 0


def test_frame_cap_keeps_clock_honest():
    engine = ReplayEngine(make_ticks(10_000), start_ms=0, speed=10_000.0, max_per_frame=100)
    batch = engine.advance(1000)
    assert len(batch) == 100
    assert engine.time == int(batch.t[-1])


def test_seek_resets_cursor_and_history():
    ticks = make_ticks(50)
    engine = ReplayEngine(ticks, start_ms=10_000, speed=1)
    assert len(engine.history) == 10
    engine.seek(30_000)
    assert engine.time == 30_000
    assert len(engine.history) == 30
    assert not engine.ended


def test_seek_clamps_to_dataset_start():
    engine = ReplayEngine(make_ticks(10), start_ms=5_000, speed=1)
    engine.seek(-1_000_000)
    assert engine.time == 0
