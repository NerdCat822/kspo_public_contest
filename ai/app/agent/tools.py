"""에이전트 도구. 모두 Go 백엔드의 공공데이터 API 를 읽기만 한다.

결과는 JSON 을 그대로 넘기지 않고 짧은 한국어 텍스트로 줄여서 돌려준다(토큰 절약, 읽기 쉬움).
실패하면 ToolError 를 던져 모델이 실패 사실을 알고 답하게 한다.
상담은 스트리밍으로 돌리므로 도구 입력도 만들어지는 대로 받는다(eager_input_streaming). 인자에 타입이 있어
SDK 가 입력을 검사한 뒤에만 함수를 부른다.
"""

from __future__ import annotations

import re
from typing import Any

import httpx2
from anthropic import beta_tool
from anthropic.lib.tools import ToolError

from . import gilmak_api

LEVEL = {"calm": "여유", "normal": "보통", "busy": "붐빔", "jam": "매우 붐빔"}
DAY_TYPE = {"weekday": "평일", "weekend": "주말", "holiday": "공휴일"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _fetch(path: str, **params: Any) -> dict[str, Any]:
    try:
        return gilmak_api.get(path, **params)
    except httpx2.HTTPStatusError as e:
        raise ToolError(f"길막닥터 API 오류({e.response.status_code}): {path}") from e
    except httpx2.HTTPError as e:
        raise ToolError(f"길막닥터 API 에 연결하지 못했어요: {path}") from e


def _end30(t: str) -> str:
    h, m = map(int, t.split(":"))
    total = h * 60 + m + 30
    return f"{total // 60:02d}:{total % 60:02d}"


def _runs(bins: list[dict[str, Any]]) -> list[str]:
    """같은 단계가 이어지는 구간으로 묶는다: '06:00~09:30 여유'"""
    out: list[str] = []
    start = prev = None
    for b in bins:
        if prev is not None and b["level"] == prev["level"]:
            prev = b
            continue
        if prev is not None:
            out.append(f"{start['t']}~{_end30(prev['t'])} {LEVEL[prev['level']]}")
        start = prev = b
    if prev is not None:
        out.append(f"{start['t']}~{_end30(prev['t'])} {LEVEL[prev['level']]}")
    return out


@beta_tool(eager_input_streaming=True)
def get_overview(days: int = 14) -> str:
    """오늘부터 며칠 동안 날짜별로 가장 붐비는 시각과 예상 단계, 2,000석 이상 대형 공연을 알려 준다.
    언제 붐비는 날인지 고르거나 '이번 주말', '다음 주' 같은 기간을 볼 때 쓴다.

    Args:
        days: 오늘부터 볼 날 수(1~31).
    """
    days = max(1, min(int(days), 31))
    data = _fetch("/api/overview", days=days)
    lines = []
    for d in data["days"]:
        shows = ", ".join(f"{s['start']} {s['hall']} {s['seats']:,}석 「{s['name']}」" for s in d["majorShows"]) or "대형 공연 없음"
        holiday = f" {d['holidayName']}" if d.get("holidayName") else ""
        lines.append(f"{d['date']}({d['weekday']}{holiday}) 가장 붐빔 {d['peakTime']} {LEVEL[d['peakLevel']]} | {shows}")
    return "\n".join(lines)


@beta_tool(eager_input_streaming=True)
def get_day_forecast(date: str) -> str:
    """특정 날짜의 30분 단위 주차 혼잡 예측, 공연 일정, 처방(권장 도착 시각, 공연 후 출차가 몰리는 구간,
    공원 방문 추천·회피 시간), 기상청 날씨를 알려 준다.

    Args:
        date: YYYY-MM-DD 형식 날짜.
    """
    if not DATE_RE.match(date):
        raise ToolError("date 는 YYYY-MM-DD 형식이어야 해요.")
    d = _fetch("/api/day", date=date)
    holiday = f", {d['holidayName']}" if d.get("holidayName") else ""
    lines = [f"{d['date']}({d['weekday']}) {DAY_TYPE.get(d['dayType'], d['dayType'])}{holiday}"]

    if d["shows"]:
        lines.append("공연:")
        for s in d["shows"]:
            rt = "" if s["runtimeKnown"] else ", 런타임 정보 없어 추정"
            mark = "" if s["major"] else " (소규모, 예측 미반영)"
            lines.append(f"- {s['start']}~{s['end']} {s['hall']} {s['seats']:,}석 「{s['name']}」{rt}{mark}")
    else:
        lines.append("공연: 없음")

    f = d["forecast"]
    lines.append(f"가장 붐비는 때: {f['peak']['t']} {LEVEL[f['peak']['level']]}")
    lines.append("시간대별: " + " / ".join(_runs(f["bins"])))

    for a in d["advice"]["concert"]:
        show = next((s for s in d["shows"] if s["id"] == a["showId"]), None)
        name = f"「{show['name']}」 {show['hall']}" if show else a["showId"]
        busy = f"{a['busyFrom']}부터 붐빔" if a.get("busyFrom") else "공연 전까지 크게 붐비지 않음"
        how = "대중교통 권장(공연 3시간 전부터 이미 붐빔)" if a["transitFirst"] else f"{a['arriveBy']} 전 도착 권장"
        lines.append(f"처방[{name} {a['start']}]: {how}, {busy}, 차로 온다면 {a['arriveBy']} 전 도착, 출차 집중 {a['exitRush']['from']}~{a['exitRush']['to']}")

    park = d["advice"]["park"]
    best = ", ".join(f"{w['from']}~{w['to']}" for w in park["best"]) or "없음"
    avoid = ", ".join(f"{w['from']}~{w['to']}({'공연 영향' if w['reason'] == 'event' else '평소 혼잡'})" for w in park["avoid"]) or "없음"
    lines.append(f"공원 방문 추천: {best} | 피할 시간: {avoid}")

    w = d.get("weather")
    if w:
        rain = f", 강수확률 {w['rainChance']:.0f}%" if w.get("rainChance") is not None else ""
        kind = w.get("precipType") or w.get("sky") or ""
        lines.append(f"날씨(기상청): {kind} 최저 {w['minTemp']:.0f}° 최고 {w['maxTemp']:.0f}°{rain}")
    m = d["model"]
    lines.append(f"모델: {m['version']}({m.get('source', '')}), 학습 기간 공연일 평균 오차 ±{m.get('fitMaeCars') or 0:.0f}대, 공연 후 출차 80% 소요 {m['exitMinutes']}분")
    return "\n".join(lines)


@beta_tool(eager_input_streaming=True)
def get_live_status() -> str:
    """지금 올림픽공원의 실시간 주차대수(동2·남2·북2문 합계), 주변 도로 소통, 공원 인구 혼잡, 날씨,
    반경 3km 공사·통제, 주변 공영주차장 면수·요금, 가까운 지하철역을 알려 준다."""
    d = _fetch("/api/live")
    lines = [f"기준 시각: {d['fetchedAt']}"]
    if d.get("parking"):
        lines.append(f"실시간 주차: {d['parking']['sum']:,}대 (장기주차 차량 포함 가능)")
    if d.get("road"):
        r = d["road"]
        lines.append(f"주변 도로: {r['level']} 평균 {r['speed']:.0f}km/h ({r['message']})")
    if d.get("population"):
        p = d["population"]
        lines.append(f"공원 인구: {p['level']} {p['min']:,}~{p['max']:,}명")
    if d.get("weather"):
        w = d["weather"]
        lines.append(f"날씨: {w['temp']}° {w.get('sky') or ''} 강수 {w['precipType']}")
    controls = d.get("controls") or []
    if controls:
        lines.append("공사·통제:")
        for c in controls[:5]:
            until = f", {c['to'][:10]}까지" if c.get("to") else ""
            dist = f"{c['distanceM']}m" if c.get("distanceM") is not None else ""
            lines.append(f"- {c['kind']} {dist}{until}: {c['info']}")
    else:
        lines.append("공사·통제: 없음")
    lots = d.get("lots") or []
    if lots:
        lines.append("주변 공영주차장(실시간 빈자리 정보 없음): " + ", ".join(f"{l['name']} {l['capacity']:,}면" for l in lots))
    stations = sorted({f"{s['name']}({s['line']}호선)" for s in d.get("stations") or []})
    if stations:
        lines.append("지하철역: " + ", ".join(stations))
    errors = d.get("errors") or {}
    if errors:
        lines.append("일부 정보를 못 받음: " + ", ".join(errors))
    return "\n".join(lines)


@beta_tool(eager_input_streaming=True)
def search_shows(keyword: str, days: int = 31) -> str:
    """오늘부터 며칠 동안 올림픽공원 공연 가운데 공연명이나 공연장 이름에 keyword 가 들어간 회차를 찾는다.
    소규모 공연도 포함한다. 가수나 공연 이름으로 날짜를 찾을 때 쓴다.

    Args:
        keyword: 공연명, 가수 이름, 공연장 이름의 일부.
        days: 오늘부터 찾을 날 수(1~31).
    """
    days = max(1, min(int(days), 31))
    data = _fetch("/api/shows", days=days)
    key = keyword.replace(" ", "").lower()
    hits = [s for s in data["shows"] if key in (s["name"] + s["hall"]).replace(" ", "").lower()]
    if not hits:
        return f"앞으로 {days}일 동안 '{keyword}' 공연을 찾지 못했어요."
    return "\n".join(f"{s['date']} {s['start']}~{s['end']} {s['hall']} {s['seats']:,}석 「{s['name']}」" for s in hits[:40])


TOOLS = [get_overview, get_day_forecast, get_live_status, search_shows]
