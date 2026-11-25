from pathlib import Path

from app.config import AI_DIR, ROOT_DIR
from app.ml.model_v0 import BaselineModel, ShowInput, round_half_away

SERVED = AI_DIR / "models" / "baseline-v1.json"  # 서비스가 쓰는 모델(app/config.py 기본값)
MODEL = BaselineModel(SERVED)


def test_same_artifact_as_go_fallback():
    """Go 백엔드는 이 서비스가 꺼져 있으면 내장 모델로 계산한다. 두 파일이 같아야 결과가 같다."""
    go_copy = ROOT_DIR / "backend" / "internal" / "model" / "baseline.json"
    assert Path(SERVED).read_bytes() == go_copy.read_bytes()


def test_meta_for_screen():
    """화면 문구(학습 기간, 검증 오차, 출차 소요시간을 잰 회차 수)가 모델 파일에서 나온다."""
    m = MODEL.meta()
    assert m["version"].startswith("v1") and m["period"] and m["note"]
    assert m["testMaeCars"] is not None and m["testLabel"]
    assert m["exitShows"] > 0 and m["exitMinutes"] > 0


def test_range_and_no_event_share():
    f = MODEL.forecast_day("weekday", [])
    assert len(f["bins"]) == 36
    assert f["bins"][0]["t"] == "06:00" and f["bins"][-1]["t"] == "23:30"
    assert all(b["eventShare"] == 0 for b in f["bins"])


def test_big_show_peaks_busy_or_more():
    # 2025년 기준(v1)으로는 평일 저녁 KSPO DOME 공연 하나면 '붐빔', 겹치거나 주말이면 '매우 붐빔'까지 오른다
    quiet = MODEL.forecast_day("weekday", [])
    busy = MODEL.forecast_day("weekday", [ShowInput(start="19:00", seats=15000, major=True)])
    # 공연 없는 평일도 오전이 '붐빔'이라 단계 대신 혼잡 수치(ratio)로 비교한다
    rank = {"calm": 0, "normal": 1, "busy": 2, "jam": 3}
    peak_ratio = lambda f: max(b["ratio"] for b in f["bins"])  # noqa: E731
    assert rank[busy["peak"]["level"]] >= 2 and peak_ratio(busy) > peak_ratio(quiet)
    i = next(i for i, b in enumerate(busy["bins"]) if b["t"] == "19:00")
    assert busy["bins"][i]["ratio"] > quiet["bins"][i]["ratio"]


def test_minor_show_ignored():
    a = MODEL.forecast_day("weekend", [])
    b = MODEL.forecast_day("weekend", [ShowInput(start="15:00", seats=237, major=False)])
    assert a == b


def test_round_half_away_matches_go():
    assert round_half_away(0.1235, 3) == 0.124  # 파이썬 round 는 0.123 이 될 수 있다
    assert round_half_away(2.5, 0) == 3.0
