from pathlib import Path

from app.config import AI_DIR, ROOT_DIR
from app.ml.model_v0 import BaselineModel, ShowInput, round_half_away

SERVED = AI_DIR / "models" / "baseline-v0.json"  # 서비스가 쓰는 모델(app/config.py 기본값)
MODEL = BaselineModel(SERVED)


def test_same_artifact_as_go_fallback():
    """Go 백엔드는 이 서비스가 꺼져 있으면 내장 모델로 계산한다. 두 파일이 같아야 결과가 같다."""
    go_copy = ROOT_DIR / "backend" / "internal" / "model" / "baseline.json"
    assert Path(SERVED).read_bytes() == go_copy.read_bytes()


def test_meta_for_screen():
    """화면 문구(학습 기간, 검증 오차, 출차 소요시간을 잰 회차 수)가 모델 파일에서 나온다."""
    m = MODEL.meta()
    assert m["version"] and m["period"] and m["note"]
    assert m["exitShows"] > 0 and m["exitMinutes"] > 0


def test_range_and_no_event_share():
    f = MODEL.forecast_day("weekday", [])
    assert len(f["bins"]) == 36
    assert f["bins"][0]["t"] == "06:00" and f["bins"][-1]["t"] == "23:30"
    assert all(b["eventShare"] == 0 for b in f["bins"])


def test_big_show_peaks_as_jam():
    quiet = MODEL.forecast_day("weekday", [])
    busy = MODEL.forecast_day("weekday", [ShowInput(start="19:00", seats=15000, major=True)])
    assert busy["peak"]["level"] == "jam"
    i = next(i for i, b in enumerate(busy["bins"]) if b["t"] == "19:00")
    assert busy["bins"][i]["ratio"] > quiet["bins"][i]["ratio"]


def test_minor_show_ignored():
    a = MODEL.forecast_day("weekend", [])
    b = MODEL.forecast_day("weekend", [ShowInput(start="15:00", seats=237, major=False)])
    assert a == b


def test_round_half_away_matches_go():
    assert round_half_away(0.1235, 3) == 0.124  # 파이썬 round 는 0.123 이 될 수 있다
    assert round_half_away(2.5, 0) == 3.0
