"""Replay clock.

The engine is deliberately free of I/O and asyncio: it advances a virtual clock
and hands back the tick slice that became visible. That makes the pacer unit
testable and keeps the websocket layer thin.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import MAX_TICKS_PER_FRAME
from .store import Ticks


@dataclass
class ReplayEngine:
    ticks: Ticks
    start_ms: int
    speed: float = 10.0
    max_per_frame: int = MAX_TICKS_PER_FRAME

    def __post_init__(self) -> None:
        self.time = int(self.start_ms)
        self.ptr = int(np.searchsorted(self.ticks.t, self.time, side="left"))
        self.ended = self.ptr >= len(self.ticks)

    @property
    def history(self) -> Ticks:
        """Everything hidden behind the current cursor."""
        return self.ticks.slice(0, self.ptr)

    @property
    def start(self) -> int:
        return int(self.ticks.t[0]) if len(self.ticks) else self.start_ms

    @property
    def end(self) -> int:
        return int(self.ticks.t[-1]) if len(self.ticks) else self.start_ms

    def seek(self, when_ms: int) -> None:
        self.time = int(max(when_ms, self.start))
        self.ptr = int(np.searchsorted(self.ticks.t, self.time, side="left"))
        self.ended = self.ptr >= len(self.ticks)

    def advance(self, wall_ms: float) -> Ticks:
        """Advance the virtual clock by ``wall_ms * speed`` milliseconds."""
        if self.ended or wall_ms <= 0:
            return self.ticks.slice(0, 0)

        self.time = int(self.time + wall_ms * self.speed)
        idx = int(np.searchsorted(self.ticks.t, self.time, side="right"))

        if idx - self.ptr > self.max_per_frame:
            idx = self.ptr + self.max_per_frame
            # Do not let the clock outrun undelivered ticks.
            self.time = int(self.ticks.t[idx - 1])

        batch = self.ticks.slice(self.ptr, idx)
        self.ptr = idx
        if self.ptr >= len(self.ticks):
            self.ended = True
            self.time = self.end
        return batch


__all__ = ["ReplayEngine"]
