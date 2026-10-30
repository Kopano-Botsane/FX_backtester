from datetime import date, timedelta

import numpy as np

from app.config import INSTRUMENTS
from app.store import default_start_ms
from app import synth


def test_generation_is_deterministic():
    day = date(2026, 3, 17)
    a = synth.generate_ticks("EURUSD", day)
    b = synth.generate_ticks("EURUSD", day)
    assert np.array_equal(a["t"], b["t"])
    assert np.array_equal(a["p"], b["p"])


def test_ticks_are_ordered_and_inside_session():
    day = date(2026, 3, 17)
    ticks = synth.generate_ticks("EURUSD", day)
    assert len(ticks["t"]) > 1000
    assert np.all(np.diff(ticks["t"]) >= 0)
    start, end = synth.day_bounds_utc(day, INSTRUMENTS["EURUSD"])
    assert ticks["t"][0] >= start
    assert ticks["t"][-1] <= end
    assert np.all(ticks["p"] > 0)


def test_days_are_continuous_for_fx():
    """The bridge should pin each close to the next session open."""
    day = date(2026, 3, 17)
    today = synth.generate_ticks("EURUSD", day)
    tomorrow = synth.generate_ticks("EURUSD", day + timedelta(days=1))
    tick = 10 ** -INSTRUMENTS["EURUSD"].digits
    assert abs(today["p"][-1] - tomorrow["p"][0]) <= tick * 2


def test_weekends_have_no_ticks():
    saturday = date(2026, 3, 21)
    assert not synth.is_trading_day("EURUSD", saturday)
    assert len(synth.generate_ticks("EURUSD", saturday)["t"]) == 0


def test_stock_session_restricted():
    day = date(2026, 3, 17)
    ticks = synth.generate_ticks("AAPL", day)
    start, end = synth.day_bounds_utc(day, INSTRUMENTS["AAPL"])
    assert ticks["t"][0] >= start
    assert ticks["t"][-1] <= end


def test_default_start_inside_session():
    day = date(2026, 3, 17)
    start, end = synth.day_bounds_utc(day, INSTRUMENTS["EURUSD"])
    point = default_start_ms("EURUSD", day)
    assert start < point < end
