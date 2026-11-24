"""KOPIS에서 올림픽공원(시설 ID FC001247) 공연 목록과 상세를 받아 JSON으로 저장한다.

사용법:
    python3 analysis/fetch_kopis_events.py .env 20240701 20240731 data/derived/kopis_events_2024_07.json
    python3 analysis/fetch_kopis_events.py .env 20250101 20251231 data/derived/kopis_events_2025.json

- 키는 .env 의 KOPIS_API_KEY 를 읽는다(출력에 노출하지 않는다).
- 공연목록(pblprfr)은 송파구(signgucode=11, signgucodesub=1171)로 조회한 뒤 시설명으로 거른다.
  KOPIS 목록은 한 번에 31일까지만 조회되므로 기간을 달 단위로 나눠 부르고 공연 ID 로 중복을 없앤다.
- 공연상세에서 공연장(관), 요일별 공연시간(dtguidance), 런타임을 가져온다.
"""
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = "http://www.kopis.or.kr/openApi/restful"
FACILITY_ID = "FC001247"  # 올림픽공원


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_xml(url, tries=4):
    """KOPIS 는 짧은 시간에 많이 부르면 400/5xx 로 거절할 때가 있어 잠시 쉬었다 다시 부른다."""
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return ET.fromstring(r.read().decode("utf-8", "replace"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ET.ParseError):
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def month_chunks(stdate, eddate):
    """'20250101'~'20251231' → [('20250101','20250131'), ('20250201','20250228'), ...]"""
    a = dt.datetime.strptime(stdate, "%Y%m%d").date()
    end = dt.datetime.strptime(eddate, "%Y%m%d").date()
    while a <= end:
        nxt = (a.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        b = min(end, nxt - dt.timedelta(days=1))
        yield a.strftime("%Y%m%d"), b.strftime("%Y%m%d")
        a = nxt


def main():
    env_path, stdate, eddate, out_path = sys.argv[1:5]
    key = urllib.parse.quote(load_env(env_path)["KOPIS_API_KEY"], safe="")

    # 시설 상세: 관별 좌석 수
    fac = get_xml(f"{BASE}/prfplc/{FACILITY_ID}?service={key}").find("db")
    halls = {}
    for m in fac.findall(".//mt13"):
        seats = (m.findtext("seatscale") or "0").replace(",", "")
        halls[m.findtext("mt13id")] = {"name": m.findtext("prfplcnm"), "seats": int(seats or 0)}

    # 공연 목록 (달 단위로 나눠 페이지 순회)
    ids = []
    for a, b in month_chunks(stdate, eddate):
        page = 1
        while True:
            root = get_xml(
                f"{BASE}/pblprfr?service={key}&stdate={a}&eddate={b}"
                f"&cpage={page}&rows=100&signgucode=11&signgucodesub=1171"
            )
            rows = root.findall("db")
            ids += [r.findtext("mt20id") for r in rows if "올림픽공원" in (r.findtext("fcltynm") or "")]
            if len(rows) < 100:
                break
            page += 1
            time.sleep(0.2)
    ids = list(dict.fromkeys(ids))  # 여러 달에 걸친 공연은 한 번만

    events, failed = [], []
    for pid in ids:
        try:
            d = get_xml(f"{BASE}/pblprfr/{pid}?service={key}").find("db")
        except Exception as e:  # 한두 건 실패로 전체를 버리지 않는다. 실패한 ID 는 따로 남긴다
            failed.append({"id": pid, "error": type(e).__name__})
            continue
        events.append(
            {
                "id": pid,
                "name": d.findtext("prfnm"),
                "genre": d.findtext("genrenm"),
                "from": d.findtext("prfpdfrom"),
                "to": d.findtext("prfpdto"),
                "facility": d.findtext("fcltynm"),
                "hallId": d.findtext("mt10id"),
                "schedule": d.findtext("dtguidance"),
                "runtime": d.findtext("prfruntime"),
                "state": d.findtext("prfstate"),
            }
        )
        time.sleep(0.15)

    json.dump({"halls": halls, "events": events, "failed": failed}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"halls={len(halls)} events={len(events)} failed={len(failed)} -> {out_path}")


if __name__ == "__main__":
    main()
