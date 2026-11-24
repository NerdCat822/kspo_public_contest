"""기준선 예측 모델. 모델 파일 형식은 v0(2024년 7월)과 v1(2025년)이 같고, 서비스는 v1 을 쓴다.

    수요(t) = 요일 유형별 기준선(t) + Σ 공연별 (좌석/1000) × 공연 영향 곡선(t - 시작)

v1 은 analysis/build_model_v1.py, v0 은 analysis/build_baseline.py 가 만든다.
단계는 학습 기간 08~23시 구간 분포의 50/80/95 분위로 나눈다.
Go 백엔드(backend/internal/model)의 내장 모델과 같은 계산을 한다. Go 는 이 서비스가 꺼져 있을 때
내장 모델로 대신 계산하므로, 둘의 결과가 같아야 한다(tests/test_model_v0.py 가 확인).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LEVELS = ("calm", "normal", "busy", "jam")
RANK = {name: i for i, name in enumerate(LEVELS)}
VIEW_FROM, VIEW_TO = 6 * 60, 24 * 60


def hhmm(minutes: int) -> str:
    m = minutes % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def round_half_away(value: float, digits: int) -> float:
    """Go 의 math.Round 와 같게(0.5 는 0에서 먼 쪽으로) 반올림한다. 파이썬 round 는 짝수 쪽으로 반올림한다."""
    p = 10**digits
    return math.copysign(math.floor(abs(value) * p + 0.5) / p, value)


@dataclass(frozen=True)
class ShowInput:
    start: str
    seats: int
    major: bool


class BaselineModel:
    def __init__(self, path: Path):
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        self.meta_raw = data["meta"]
        self.bin_minutes: int = data["binMinutes"]
        self.weekday: list[float] = data["baseline"]["weekday"]
        self.weekend: list[float] = data["baseline"]["weekend"]
        self.kernel_offset: int = data["eventKernelPer1000Seats"]["offsetFromStartMinutes"]
        self.kernel: list[float] = data["eventKernelPer1000Seats"]["values"]
        th = data["thresholds"]
        self.p50, self.p80, self.p95 = th["p50"], th["p80"], th["p95"]
        self.exit_minutes: int = data["exitSurge"].get("medianMinutesTo80pct") or 70
        self.exit_shows: int = data["exitSurge"].get("showsUsed") or len(data["exitSurge"].get("shows") or [])

    @property
    def bins(self) -> int:
        return 24 * 60 // self.bin_minutes

    def thresholds(self) -> dict[str, float]:
        return {"normal": self.p50 / self.p95, "busy": self.p80 / self.p95, "jam": 1.0}

    def meta(self) -> dict[str, Any]:
        return {
            "version": self.meta_raw["version"],
            "period": self.meta_raw.get("period", ""),
            "fitMaeCars": self.meta_raw.get("fitMaeCars"),
            "testMaeCars": self.meta_raw.get("testMaeCars"),
            "testLabel": self.meta_raw.get("testLabel"),
            "exitMinutes": self.exit_minutes,
            "exitShows": self.exit_shows,
            "note": self.meta_raw.get("note", ""),
        }

    def level_of(self, cars: float) -> str:
        if cars >= self.p95:
            return "jam"
        if cars >= self.p80:
            return "busy"
        if cars >= self.p50:
            return "normal"
        return "calm"

    def forecast_day(self, day_type: str, shows: list[ShowInput]) -> dict[str, Any]:
        """06:00~24:00 30분 구간 수요. day_type 은 weekday | weekend | holiday(주말 기준선 사용)."""
        base = self.weekday if day_type == "weekday" else self.weekend
        effect = [0.0] * self.bins
        for s in shows:
            if not s.major:
                continue
            sb = to_minutes(s.start) // self.bin_minutes
            for i, k in enumerate(self.kernel):
                b = sb + self.kernel_offset // self.bin_minutes + i
                if 0 <= b < self.bins:
                    effect[b] += k * s.seats / 1000

        out = []
        for b in range(VIEW_FROM // self.bin_minutes, VIEW_TO // self.bin_minutes):
            cars = base[b] + effect[b]
            out.append(
                {
                    "t": hhmm(b * self.bin_minutes),
                    "level": self.level_of(cars),
                    "ratio": round_half_away(cars / self.p95, 3),
                    "eventShare": round_half_away(effect[b] / cars, 2) if cars > 0 else 0.0,
                }
            )
        peak = out[0]
        for x in out[1:]:
            if x["ratio"] > peak["ratio"]:
                peak = x
        return {"bins": out, "peak": {"t": peak["t"], "level": peak["level"]}}
