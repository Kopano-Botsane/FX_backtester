"""Order simulation: fills, positions and P&L against the replay cursor.

Pure computation, no I/O or asyncio — same style as :mod:`app.replay`, so the
websocket layer stays thin and the trading rules are unit-testable.

Model
-----
- P&L is in the quote currency (USD for XAUUSD). Size is in instrument units:
  one unit of size earns/loses one unit of quote currency per point of price.
  The account starts with zero realized P&L, so "cash" is total realized P&L
  and "equity" is cash plus the mark-to-market of the open position.
- Net position model: orders add to, reduce, or flip a signed position. An
  order larger than the current position closes it and opens the remainder in
  the opposite direction (one closed trade plus one new entry).
- Market orders fill at the last price under the cursor. Limit/stop/SL/TP all
  fill at their trigger price the moment the tape touches it (no slippage, no
  queue simulation — a documented v1 simplification).
- Trigger directions: a buy limit fills when price <= level, a sell limit when
  price >= level; stops and SL mirror it for the other direction. A long TP
  acts like a sell limit above; a short TP like a buy limit below.
- SL/TP attach to the position. They may be set with an order or replaced
  later; they are cleared when the position closes and re-attach on a flip.
- Drawdown is tracked incrementally (peak equity vs trough), never as a
  per-tick series — a 1000x replay day would produce millions of samples.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

import numpy as np

from .store import Ticks

MAX_FILL_MARKERS = 512


def _first_true(mask: np.ndarray, start: int) -> int | None:
    """Index of the first True at or after ``start``; None when none."""
    if start >= mask.size:
        return None
    sub = mask[start:]
    k = int(np.argmax(sub))
    return start + k if sub[k] else None


def _side_label(side: int) -> str:
    return "buy" if side > 0 else "sell"


@dataclass
class Fill:
    t: int
    price: float
    size: float
    side: int  # signed: 1 buy, -1 sell
    kind: str  # market | limit | stop | sl | tp
    role: str  # entry | close | flip
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "t": self.t,
            "price": self.price,
            "size": self.size,
            "side": _side_label(self.side),
            "kind": self.kind,
            "role": self.role,
        }


@dataclass
class Trade:
    side: int  # direction of the position that was closed
    size: float
    entry_id: str
    entry_t: int
    entry_price: float
    exit_id: str
    exit_t: int
    exit_price: float
    pnl: float
    reason: str  # order | sl | tp | flatten
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "side": _side_label(self.side),
            "size": self.size,
            "entryId": self.entry_id,
            "entryT": self.entry_t,
            "entryPrice": self.entry_price,
            "exitId": self.exit_id,
            "exitT": self.exit_t,
            "exitPrice": self.exit_price,
            "pnl": self.pnl,
            "reason": self.reason,
        }


@dataclass
class PendingOrder:
    kind: str  # limit | stop
    side: int
    size: float
    price: float
    t: int
    sl: float | None = None
    tp: float | None = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "side": _side_label(self.side),
            "size": self.size,
            "price": self.price,
            "t": self.t,
        }


class Book:
    """A single session's simulated account: orders, position, P&L, stats."""

    def __init__(self) -> None:
        self.cash = 0.0  # realized P&L
        self.pos = 0.0  # signed net position
        self.avg = 0.0  # average entry price of the open position
        self.sl: float | None = None
        self.tp: float | None = None
        self.pending: list[PendingOrder] = []
        self.fills: list[Fill] = []
        self.trades: list[Trade] = []
        self.now = 0
        self.last_price = 0.0
        self.peak_equity = 0.0
        self.max_drawdown = 0.0
        self.open_entry_t = 0
        self.open_entry_price = 0.0
        self.open_entry_id = ""

    # ---------------------------------------------------------------- state

    def unrealized(self, price: float | None = None) -> float:
        p = self.last_price if price is None else price
        return self.pos * (p - self.avg) if self.pos else 0.0

    def equity(self, price: float | None = None) -> float:
        return self.cash + self.unrealized(price)

    def reset(self, now: int, last: float) -> None:
        """Clear the account for a new/seeked session."""
        self.cash = 0.0
        self.pos = 0.0
        self.avg = 0.0
        self.sl = None
        self.tp = None
        self.pending = []
        self.fills = []
        self.trades = []
        self.peak_equity = 0.0
        self.max_drawdown = 0.0
        self.open_entry_t = 0
        self.open_entry_price = 0.0
        self.open_entry_id = ""
        self.now = int(now)
        self.last_price = float(last)

    # ------------------------------------------------------------- commands

    def place(
        self,
        side: int,
        size: float,
        kind: str,
        price: float,
        sl: float | None = None,
        tp: float | None = None,
    ) -> str:
        """Place an order. Returns an error message, or "" when accepted."""
        if kind not in ("market", "limit", "stop"):
            return f"unknown order kind {kind!r}"
        if not (size > 0) or not np.isfinite(size):
            return "size must be a positive number"
        if kind == "market":
            self._fill(self.now, self.last_price, size, side, "market")
            self._attach(sl, tp)
            self._mark()
            return ""
        if not (np.isfinite(price) and price > 0):
            return f"{kind} orders need a trigger price"
        if self._triggered(kind, side, price, self.last_price):
            # Trigger already behind the market: touch it right now.
            self._fill(self.now, self.last_price, size, side, kind)
            self._attach(sl, tp)
            self._mark()
            return ""
        self.pending.append(PendingOrder(kind, side, size, price, self.now, sl, tp))
        return ""

    def cancel(self, order_id: str) -> str:
        for i, order in enumerate(self.pending):
            if order.id == order_id:
                del self.pending[i]
                return ""
        return "no such pending order"

    def flatten(self) -> str:
        """Close the position now; clear SL/TP and cancel pending orders."""
        self.pending.clear()
        if self.pos == 0:
            return ""
        self._fill(
            self.now,
            self.last_price,
            abs(self.pos),
            -1 if self.pos > 0 else 1,
            "market",
            reason="flatten",
        )
        self._attach(None, None)
        self._mark()
        return ""

    def set_sltp(self, sl: float | None, tp: float | None) -> str:
        """Replace the open position's SL/TP; None clears that level."""
        if self.pos == 0:
            self.sl = self.tp = None
            return ""
        if (self.sl_ok(sl) or sl is None) and (self.tp_ok(tp) or tp is None):
            self.sl, self.tp = sl, tp
            return ""
        return "stop/limit level is on the wrong side of the entry"

    # --------------------------------------------------------------- ticks

    def on_ticks(self, batch: Ticks) -> None:
        """Feed a tick batch; process fills/SL/TP in tape order."""
        n = len(batch.t)
        if n == 0:
            return
        price = batch.p
        i = 0
        while True:
            # Earliest pending-order trigger still ahead of the cursor.
            ev: tuple[int, PendingOrder] | None = None
            for order in self.pending:
                idx = self._order_index(order, price, i)
                if idx is not None and (ev is None or idx < ev[0]):
                    ev = (idx, order)
            # SL/TP close earlier/earliest wins ties against orders (a stop
            # filled by the same tick that touches an opposite trigger is
            # ambiguous; protecting the open position first is safer).
            stopping = self._sltp_index(price, i)
            if stopping is not None and (ev is None or stopping[0] <= ev[0]):
                idx, reason, level = stopping
                when = int(batch.t[idx])
                side = -1 if self.pos > 0 else 1
                self._fill(when, level, abs(self.pos), side, reason, reason=reason)
                i = idx + 1
                continue
            if ev is None:
                break
            idx, order = ev
            self.pending.remove(order)
            self._fill(int(batch.t[idx]), order.price, order.size, order.side, order.kind)
            self._attach(order.sl, order.tp)
            i = idx + 1
        self.last_price = float(batch.p[-1])
        self.now = int(batch.t[-1])
        self._mark()

    # ------------------------------------------------------------ internals

    def _triggered(self, kind: str, side: int, level: float, price: float) -> bool:
        if kind == "limit":
            return price <= level if side > 0 else price >= level
        return price >= level if side > 0 else price <= level

    def _order_index(self, order: PendingOrder, price: np.ndarray, start: int) -> int | None:
        """First tick index from ``start`` whose price touches the trigger."""
        if order.kind == "limit":
            mask = price <= order.price if order.side > 0 else price >= order.price
        else:
            mask = price >= order.price if order.side > 0 else price <= order.price
        return _first_true(mask, start)

    def _sltp_index(self, price: np.ndarray, start: int) -> tuple[int, str, float] | None:
        """Next (tick index, reason, level) closing the open position."""
        if self.pos == 0 or (self.sl is None and self.tp is None):
            return None
        if self.pos > 0:
            idx = _first_true(price <= self.sl, start) if self.sl is not None else None
            if self.tp is not None:
                tp_idx = _first_true(price >= self.tp, start)
                if tp_idx is not None and (idx is None or tp_idx < idx):
                    return (tp_idx, "tp", self.tp)
            return None if idx is None else (idx, "sl", self.sl)
        idx = _first_true(price >= self.sl, start) if self.sl is not None else None
        if self.tp is not None:
            tp_idx = _first_true(price <= self.tp, start)
            if tp_idx is not None and (idx is None or tp_idx < idx):
                return (tp_idx, "tp", self.tp)
        return None if idx is None else (idx, "sl", self.sl)

    def sl_ok(self, sl: float | None) -> bool:
        if self.pos == 0 or not (np.isfinite(sl) if sl is not None else False):
            return False
        return sl < self.avg if self.pos > 0 else sl > self.avg

    def tp_ok(self, tp: float | None) -> bool:
        if self.pos == 0 or not (np.isfinite(tp) if tp is not None else False):
            return False
        return tp > self.avg if self.pos > 0 else tp < self.avg

    def _attach(self, sl: float | None, tp: float | None) -> None:
        """Apply SL/TP from a just-filled order to the resulting position."""
        if self.pos == 0:
            self.sl = self.tp = None
            return
        self.sl = sl if self.sl_ok(sl) else None
        self.tp = tp if self.tp_ok(tp) else None

    def _fill(self, when: int, price: float, size: float, side: int, kind: str, reason: str = "order") -> Fill:
        """Match ``size`` against the position and record the fill/trade."""
        fill = Fill(when, price, size, side, kind, "entry")
        pos = self.pos
        if pos == 0 or (pos > 0) == (side > 0):
            # Extending the position in its own direction.
            total = abs(pos) + size
            self.avg = price if pos == 0 else (abs(pos) * self.avg + price * size) / total
            self.pos = pos + side * size
            if pos == 0:
                self.open_entry_t = when
                self.open_entry_price = price
                self.open_entry_id = fill.id
        else:
            # Reducing (and possibly flipping) the position.
            closed = min(size, abs(pos))
            pnl = closed * (price - self.avg) * (1 if pos > 0 else -1)
            self.trades.append(
                Trade(
                    side=pos,
                    size=closed,
                    entry_id=self.open_entry_id,
                    entry_t=self.open_entry_t,
                    entry_price=self.open_entry_price,
                    exit_id=fill.id,
                    exit_t=when,
                    exit_price=price,
                    pnl=pnl,
                    reason=reason,
                )
            )
            self.cash += pnl
            self.pos = pos - closed * (1 if pos > 0 else -1)
            fill.role = "close"
            if self.pos == 0:
                self.sl = self.tp = None
                self.open_entry_t = 0
                self.open_entry_price = 0.0
                self.open_entry_id = ""
            if size > closed + 1e-12:
                # Flip: remainder opens the opposite position at this fill.
                fill.role = "flip"
                remainder = size - closed
                self.pos = side * remainder
                self.avg = price
                self.open_entry_t = when
                self.open_entry_price = price
                self.open_entry_id = fill.id
        self.fills.append(fill)
        if len(self.fills) > MAX_FILL_MARKERS:
            del self.fills[: len(self.fills) - MAX_FILL_MARKERS]
        return fill

    def _mark(self) -> None:
        eq = self.equity()
        if eq > self.peak_equity:
            self.peak_equity = eq
        dd = self.peak_equity - eq
        if dd > self.max_drawdown:
            self.max_drawdown = dd

    # -------------------------------------------------------------- reports

    def stats(self) -> dict:
        wins = [t.pnl for t in self.trades if t.pnl > 0]
        losses = [t.pnl for t in self.trades if t.pnl <= 0]
        gp = float(sum(wins))
        gl = float(sum(losses))
        return {
            "count": len(self.trades),
            "wins": len(wins),
            "losses": len(losses),
            "winRate": len(wins) / len(self.trades) if self.trades else 0.0,
            "grossProfit": gp,
            "grossLoss": gl,
            "profitFactor": (gp / -gl) if gl < 0 else None,
            "avgWin": gp / len(wins) if wins else 0.0,
            "avgLoss": gl / len(losses) if losses else 0.0,
            "expectancy": gp + gl,
            "maxDrawdown": self.max_drawdown,
            "maxDrawdownPct": self.max_drawdown / self.peak_equity if self.peak_equity > 1e-12 else 0.0,
        }

    def snapshot(self) -> dict:
        return {
            "cash": self.cash,
            "position": self.pos,
            "avgPrice": self.avg,
            "lastPrice": self.last_price,
            "sl": self.sl,
            "tp": self.tp,
            "pending": [o.to_dict() for o in self.pending],
            "fills": [f.to_dict() for f in self.fills],
            "trades": [t.to_dict() for t in self.trades],
            "stats": self.stats(),
        }


__all__ = ["Book", "Fill", "PendingOrder", "Trade"]
