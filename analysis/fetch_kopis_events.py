"""KOPIS에서 올림픽공원(시설 ID FC001247) 공연 목록과 상세를 받아 JSON으로 저장한다.

사용법:
    python3 analysis/fetch_kopis_events.py .env 20240701 20240731 data/derived/kopis_events_2024_07.json

- 키는 .env 의 KOPIS_API_KEY 를 읽는다(출력에 노출하지 않는다).
- 공연목록(pblprfr)은 송파구(signgucode=11, signgucodesub=1171)로 조회한 뒤 시설명으로 거른다.
- 공연상세에서 공연장(관), 요일별 공연시간(dtguidance), 런타임을 가져온다.
"""
import json
import sys
import time
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


def get_xml(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return ET.fromstring(r.read().decode("utf-8", "replace"))


def main():
    env_path, stdate, eddate, out_path = sys.argv[1:5]
    key = urllib.parse.quote(load_env(env_path)["KOPIS_API_KEY"], safe="")

    # 시설 상세: 관별 좌석 수
    fac = get_xml(f"{BASE}/prfplc/{FACILITY_ID}?service={key}").find("db")
    halls = {}
    for m in fac.findall(".//mt13"):
        seats = (m.findtext("seatscale") or "0").replace(",", "")
        halls[m.findtext("mt13id")] = {"name": m.findtext("prfplcnm"), "seats": int(seats or 0)}

    # 공연 목록 (페이지 순회)
    ids, page = [], 1
    while True:
        root = get_xml(
            f"{BASE}/pblprfr?service={key}&stdate={stdate}&eddate={eddate}"
            f"&cpage={page}&rows=100&signgucode=11&signgucodesub=1171"
        )
        rows = root.findall("db")
        ids += [r.findtext("mt20id") for r in rows if "올림픽공원" in (r.findtext("fcltynm") or "")]
        if len(rows) < 100:
            break
        page += 1
        time.sleep(0.2)

    events = []
    for pid in ids:
        d = get_xml(f"{BASE}/pblprfr/{pid}?service={key}").find("db")
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

    json.dump({"halls": halls, "events": events}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"halls={len(halls)} events={len(events)} -> {out_path}")


if __name__ == "__main__":
    main()
