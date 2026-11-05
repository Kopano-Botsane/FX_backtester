"""Tests for the simulated order book (app.orders)."""

from __future__ import annotations

import numpy as np

from app.orders import Book
from app.store import Ticks


def tape(*points: tuple[int, float]) -> Ticks:
    t = np.array([p[0] for p in points], dtype=np.int64)
    p = np.array([p[1] for p in points], dtype=np.float64)
    s = np.ones(len(points))
    return Ticks(t, p, s)


def test_market_order_fills_at_cursor():
    book = Book()
    book.reset(1000, 105.0)
    assert book.place(1, 10.0, "market", 0.0) == ""
    assert book.pos == 10.0
    assert book.avg == 105.0
    assert book.unrealized() == 0.0


def test_long_close_realizes_pnl():
    book = Book()
    book.reset(1000, 100.0)
    book.place(1, 10.0, "market", 0.0)
    book.on_ticks(tape((2000, 109.0), (3000, 110.0)))
    assert book.pos == 10.0
    assert book.unrealized() == 100.0
    book.flatten()
    assert book.pos == 0.0
    assert book.cash == 100.0
    assert len(book.trades) == 1
    assert book.trades[0].reason == "flatten"
    assert book.equity() == 100.0


def test_limit_buy_fills_on_touch_at_limit_price():
    book = Book()
    book.reset(1000, 105.0)
    assert book.place(1, 5.0, "limit", 100.0) == ""
    assert len(book.pending) == 1
    # First batch: no touch yet.
    book.on_ticks(tape((1500, 104.0), (2000, 102.0)))
    assert book.pos == 0.0
    assert len(book.pending) == 1
    # Touch: fill at the limit level, not the tick price.
    book.on_ticks(tape((2500, 100.4), (3000, 99.9)))
    assert book.pos == 5.0
    assert book.avg == 100.0
    assert not book.pending


def test_limit_behind_market_fills_immediately():
    book = Book()
    book.reset(1000, 105.0)
    assert book.place(1, 5.0, "limit", 110.0) == ""
    assert book.pos == 5.0
    assert book.avg == 105.0  # market fill, not the level


def test_stop_and_sl_triggers():
    book = Book()
    book.reset(1000, 100.0)
    book.place(1, 10.0, "market", 0.0, sl=96.0)
    assert book.sl == 96.0
    book.on_ticks(tape((1500, 99.0), (2000, 96.5)))
    assert book.pos == 10.0  # not yet
    book.on_ticks(tape((2500, 95.9)))
    assert book.pos == 0.0
    assert book.trades[0].reason == "sl"
    assert book.trades[0].exit_price == 96.0
    assert book.trades[0].pnl == -40.0


def test_take_profit_on_short():
    book = Book()
    book.reset(1000, 100.0)
    book.place(-1, 4.0, "market", 0.0, tp=96.0)
    assert book.pos == -4.0
    # 96.2 is above the level: a short TP triggers only when price <= 96.
    book.on_ticks(tape((2000, 96.2)))
    assert book.pos == -4.0
    book.on_ticks(tape((3000, 95.4)))
    assert book.pos == 0.0
    assert book.trades[0].reason == "tp"
    assert book.trades[0].exit_price == 96.0  # filled at the level
    assert book.trades[0].pnl == 16.0


def test_pending_stop_sell_opens_short():
    book = Book()
    book.reset(1000, 100.0)
    assert book.place(-1, 3.0, "stop", 94.0) == ""
    assert len(book.pending) == 1
    book.on_ticks(tape((1500, 95.0), (2000, 93.8)))
    assert book.pos == -3.0
    assert book.avg == 94.0
    book.on_ticks(tape((3000, 90.0)))
    assert book.unrealized() == 12.0


def test_flip_closes_then_opposite():
    book = Book()
    book.reset(1000, 100.0)
    book.place(1, 10.0, "market", 0.0)
    book.on_ticks(tape((2000, 90.0)))
    book.place(-1, 25.0, "market", 0.0)
    assert book.pos == -15.0
    assert book.cash == -100.0  # closed 10 long at 90
    assert len(book.trades) == 1
    assert book.trades[0].size == 10.0
    assert book.avg == 90.0
    assert book.open_entry_price == 90.0


def test_partial_close_keeps_avg_and_registers_trade():
    book = Book()
    book.reset(1000, 100.0)
    book.place(1, 10.0, "market", 0.0)
    book.on_ticks(tape((2000, 110.0)))
    book.place(-1, 4.0, "market", 0.0)
    assert book.pos == 6.0
    assert book.avg == 100.0
    assert book.cash == 40.0
    assert len(book.trades) == 1 and book.trades[0].size == 4.0
    # SL/TP cleared by the close-in path only when flat: still open here
    assert book.sl is None and book.tp is None


def test_cancel_pending():
    book = Book()
    book.reset(1000, 100.0)
    assert book.place(1, 1.0, "limit", 90.0) == ""
    order_id = book.pending[0].id
    assert book.cancel(order_id) == ""
    assert not book.pending
    assert book.cancel(order_id) != ""


def test_stats_and_drawdown():
    book = Book()
    book.reset(1000, 100.0)
    book.place(1, 1.0, "market", 0.0)
    book.on_ticks(tape((2000, 110.0)))
    book.flatten()  # +10
    book.place(1, 1.0, "market", 0.0)
    book.on_ticks(tape((3000, 95.0)))
    book.flatten()  # -15 → cash = 10 - 15 = -5
    stats = book.stats()
    assert stats["count"] == 2
    assert stats["wins"] == 1 and stats["losses"] == 1
    assert stats["winRate"] == 0.5
    assert stats["grossProfit"] == 10.0
    assert stats["grossLoss"] == -15.0
    assert stats["profitFactor"] == 2 / 3
    assert stats["maxDrawdown"] == 15.0  # peak realized +10 → trough +… actually trough -5 ⇒ 15
    # equity check
    assert book.cash == -5.0
    assert book.equity() == -5.0


def test_invalid_orders_rejected():
    book = Book()
    book.reset(1000, 100.0)
    assert book.place(1, 0.0, "market", 0.0) != ""
    assert book.place(1, 1.0, "limit", 0.0) != ""
    assert book.place(1, 1.0, "trailing", 0.0) != ""
    assert book.pos == 0.0


def test_bad_sltp_attachment_ignored():
    book = Book()
    book.reset(1000, 100.0)
    book.place(1, 1.0, "market", 0.0, sl=105.0, tp=95.0)  # backwards for a long
    assert book.sl is None and book.tp is None
    book2 = Book()
    book2.reset(1000, 100.0)
    book2.place(1, 1.0, "market", 0.0, sl=95.0, tp=110.0)
    assert book2.sl == 95.0 and book2.tp == 110.0
    # replace via message-style call
    assert book2.set_sltp(96.0, 108.0) == ""
    assert book2.sl == 96.0 and book2.tp == 108.0
    assert book2.set_sltp(None, None) == ""
    assert book2.sl is None and book2.tp is None
