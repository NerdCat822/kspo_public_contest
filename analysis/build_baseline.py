"""2024년 7월 입출차(동2·남2·북2문)와 KOPIS 공연 일정으로 v0 예측 기준선을 만든다.

사용법:
    python3 analysis/build_baseline.py \
        data/raw/kspo_inout_2024_07/inout_2024_07.csv \
        data/derived/kopis_events_2024_07.json \
        app/server/model/baseline.json

방법
1. 분 단위 동시 주차대수(입차 - 출차 누적)를 구하고 30분 구간 평균으로 만든다.
2. 대형 공연(2,000석 이상 공연장)이 없는 평일의 평균을 평일 기준선으로 삼는다.
3. 2024년 7월 주말은 모두 대형 공연일이라 주말 기준선을 따로 구할 수 없다. 그래서 주말 기준선과
   "좌석 1,000석당 공연 영향 곡선"(공연 시작 시각 기준)을 공연일 9일 전체에 대해 평활 제약을 둔
   최소제곱으로 동시에 추정한다. 공연 시작 시각과 규모가 날마다 달라 두 성분을 분리할 수 있다.
5. 혼잡 단계 임계값은 08~23시 30분 구간 점유 분포의 50/80/95 분위로 정한다.
6. 공연 종료 후 출차가 몰리는 시간을 실측한다.

2025년 연계 데이터를 받으면 같은 방식으로 1년치를 다시 학습한다.
"""
import csv
import datetime as dt
import json
import re
import sys

import numpy as np

BIN = 30  # 분
BINS_PER_DAY = 24 * 60 // BIN
MAJOR_MIN_SEATS = 2000
KERNEL_FROM, KERNEL_TO = -300, 360  # 공연 시작 기준 영향 범위(분)
DAYS = ["월", "화", "수", "목", "금", "토", "일"]


def parse_runtime(text):
    if not text:
        return None
    h = re.search(r"(\d+)\s*시간", text)
    m = re.search(r"(\d+)\s*분", text)
    total = (int(h.group(1)) * 60 if h else 0) + (int(m.group(1)) if m else 0)
    return total or None


def parse_schedule(text):
    """'토요일 ~ 일요일(11:00,14:00), HOL(11:00)' -> {요일번호 or 'HOL': ['11:00', ...]}"""
    out = {}
    for spec, times in re.findall(r"([^(),]+)\(([^)]*)\)", text or ""):
        spec = spec.strip()
        ts = [t.strip() for t in times.split(",") if re.match(r"^\d{1,2}:\d{2}$", t.strip())]
        if spec.upper() == "HOL":
            out.setdefault("HOL", []).extend(ts)
            continue
        names = [s.strip()[0] for s in spec.split("~")]
        if not all(n in DAYS for n in names):
            continue
        a, b = DAYS.index(names[0]), DAYS.index(names[-1])
        span = range(a, b + 1) if a <= b else list(range(a, 7)) + list(range(0, b + 1))
        for d in span:
            out.setdefault(d, []).extend(ts)
    return out


def hall_of(facility, halls):
    m = re.match(r"^[^(]*\((.*)\)\s*$", facility or "")
    inner = m.group(1).strip() if m else ""
    for h in halls.values():
        if h["name"] == inner:
            return h
    for h in halls.values():
        if inner and (inner in h["name"] or h["name"] in inner):
            return h
    return None


def main():
    csv_path, events_path, out_path = sys.argv[1:4]
    t0 = dt.datetime(2024, 7, 1)
    n_days = 31
    horizon = (n_days + 1) * 1440  # 8/1 하루치까지 출차 추적

    enter = np.zeros(horizon + 1, dtype=np.int64)
    leave = np.zeros(horizon + 1, dtype=np.int64)
    rows = 0
    with open(csv_path, encoding="cp949", newline="") as f:
        reader = csv.reader(f)
        next(reader)
        for _, tin, tout in reader:
            a = int((dt.datetime.strptime(tin, "%Y-%m-%d %H:%M") - t0).total_seconds() // 60)
            b = int((dt.datetime.strptime(tout, "%Y-%m-%d %H:%M") - t0).total_seconds() // 60) if tout.strip() else horizon
            if 0 <= a < horizon:
                enter[a] += 1
                leave[min(max(b, a), horizon)] += 1
                rows += 1
    conc = np.cumsum(enter - leave)[: n_days * 1440]
    occ = conc.reshape(n_days, BINS_PER_DAY, BIN).mean(axis=2)  # (31, 48)
    exits10 = leave[: n_days * 1440].reshape(n_days, 144, 10).sum(axis=2)  # 10분 출차

    ev = json.load(open(events_path, encoding="utf-8"))
    halls = ev["halls"]
    shows = {d: [] for d in range(n_days)}  # 날짜별 대형 공연 회차
    for e in ev["events"]:
        hall = hall_of(e["facility"], halls)
        if not hall or hall["seats"] < MAJOR_MIN_SEATS:
            continue
        sched = parse_schedule(e["schedule"])
        start = dt.datetime.strptime(e["from"], "%Y.%m.%d")
        end = dt.datetime.strptime(e["to"], "%Y.%m.%d")
        for d in range(n_days):
            day = t0 + dt.timedelta(days=d)
            if start <= day <= end:
                for t in sched.get(day.weekday(), []):
                    hh, mm = map(int, t.split(":"))
                    shows[d].append({
                        "name": e["name"], "hall": hall["name"], "seats": hall["seats"],
                        "startMin": hh * 60 + mm, "runtime": parse_runtime(e["runtime"]) or 150,
                    })

    weekday = [d for d in range(n_days) if (t0 + dt.timedelta(days=d)).weekday() < 5]
    weekend = [d for d in range(n_days) if d not in weekday]
    base_days = [d for d in weekday if not shows[d]]
    base_wd = occ[base_days].mean(axis=0)

    # 주말 기준선(48)과 공연 영향 곡선(K)을 공연일 전체로 동시에 추정한다(평활 제약을 둔 최소제곱).
    #   주말 d:          occ[d,b]            = base_we[b] + Σ (좌석/1000) * kernel[b - 시작구간]
    #   평일 공연일 d:   occ[d,b] - base_wd[b] =               Σ (좌석/1000) * kernel[b - 시작구간]
    k_bins = list(range(KERNEL_FROM // BIN, KERNEL_TO // BIN + 1))
    K = len(k_bins)
    n_var = BINS_PER_DAY + K
    A, y = [], []
    fit_days = [d for d in range(n_days) if shows[d] and (d in weekend or d in weekday)]
    for d in fit_days:
        is_we = d in weekend
        for b in range(BINS_PER_DAY):
            row = np.zeros(n_var)
            if is_we:
                row[b] = 1.0
            for s in shows[d]:
                i = b - s["startMin"] // BIN - k_bins[0]
                if 0 <= i < K:
                    row[BINS_PER_DAY + i] += s["seats"] / 1000
            A.append(row)
            y.append(occ[d][b] if is_we else occ[d][b] - base_wd[b])
    lam = 3.0  # 평활 강도(2차 차분)
    for offset, size in ((0, BINS_PER_DAY), (BINS_PER_DAY, K)):
        for j in range(1, size - 1):
            row = np.zeros(n_var)
            row[offset + j - 1], row[offset + j], row[offset + j + 1] = lam, -2 * lam, lam
            A.append(row)
            y.append(0.0)
    for j in (0, K - 1):  # 영향 범위 양 끝은 0
        row = np.zeros(n_var)
        row[BINS_PER_DAY + j] = 10.0
        A.append(row)
        y.append(0.0)
    sol, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
    base_we = np.clip(sol[:BINS_PER_DAY], 0, None)
    kernel = np.clip(sol[BINS_PER_DAY:], 0, None)
    samples = fit_days

    def effect(day_shows):
        out = np.zeros(BINS_PER_DAY)
        for s in day_shows:
            sb = s["startMin"] // BIN
            for i, o in enumerate(k_bins):
                if 0 <= sb + o < BINS_PER_DAY:
                    out[sb + o] += kernel[i] * s["seats"] / 1000
        return out

    # 적합도(학습 기간 내): 공연일 재구성 오차
    fit = []
    for d in range(n_days):
        if shows[d]:
            base = base_wd if d in weekday else base_we
            pred = base + effect(shows[d])
            fit.append(float(np.mean(np.abs(pred[16:47] - occ[d][16:47]))))

    day_bins = occ[:, 16:47].ravel()  # 08:00~23:30
    p50, p80, p95 = (float(np.percentile(day_bins, q)) for q in (50, 80, 95))

    # 공연 종료 후 출차 집중: 평일 기준 출차 대비 초과분의 80%가 빠지는 시간
    base_exit = exits10[base_days].mean(axis=0)
    exit_rows = []
    for d in range(n_days):
        for s in shows[d]:
            if s["seats"] < 10000:
                continue
            end_bin = (s["startMin"] + s["runtime"]) // 10
            window = range(end_bin - 3, min(end_bin + 18, 144))
            excess = np.clip([exits10[d][b] - base_exit[b] for b in window], 0, None)
            if excess.sum() <= 0:
                continue
            cum = np.cumsum(excess) / excess.sum()
            t80 = (int(np.argmax(cum >= 0.8)) - 3) * 10
            exit_rows.append({
                "date": (t0 + dt.timedelta(days=d)).strftime("%Y-%m-%d"), "name": s["name"], "hall": s["hall"],
                "endEstimate": f"{(s['startMin'] + s['runtime']) // 60:02d}:{(s['startMin'] + s['runtime']) % 60:02d}",
                "minutesTo80pct": t80, "excessExits": int(excess.sum()),
            })

    peak_i = int(np.argmax(conc))
    out = {
        "meta": {
            "version": "v0-2024-07",
            "source": "한국체육산업개발 올림픽공원 입출차 정보(2024년 7월, 동2·남2·북2문) + KOPIS 공연상세",
            "rows": rows,
            "baseWeekdays": len(base_days),
            "weekendDays": len(weekend),
            "eventDaysUsed": len(samples),
            "fitMaeCars": round(float(np.mean(fit)), 1) if fit else None,
            "majorHallMinSeats": MAJOR_MIN_SEATS,
            "notes": "2024년 7월 주말은 모두 대형 공연일이라 주말 기준선과 공연 영향 곡선을 공연일 9일로 동시 추정했다. 2025년 연계 데이터로 재학습 예정.",
        },
        "binMinutes": BIN,
        "baseline": {"weekday": [round(float(x), 1) for x in base_wd], "weekend": [round(float(x), 1) for x in base_we]},
        "eventKernelPer1000Seats": {"offsetFromStartMinutes": KERNEL_FROM, "values": [round(float(x), 2) for x in kernel]},
        "thresholds": {"p50": round(p50, 1), "p80": round(p80, 1), "p95": round(p95, 1)},
        "exitSurge": {
            "medianMinutesTo80pct": int(np.median([r["minutesTo80pct"] for r in exit_rows])) if exit_rows else None,
            "shows": exit_rows,
        },
        "observedPeak": {"cars": int(conc[peak_i]), "at": (t0 + dt.timedelta(minutes=peak_i)).strftime("%Y-%m-%d %H:%M")},
    }
    json.dump(out, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"rows={rows} baseWeekdays={len(base_days)} weekend={len(weekend)} eventDaysUsed={len(samples)}")
    for d in range(n_days):
        if shows[d]:
            base = base_wd if d in weekday else base_we
            pred = base + effect(shows[d])
            print(f"  {(t0 + dt.timedelta(days=d)):%m-%d} actual peak {occ[d].max():6.0f} @{occ[d].argmax() / 2:4.1f}h"
                  f" | pred peak {pred.max():6.0f} @{pred.argmax() / 2:4.1f}h")
    print("event days:", {(t0 + dt.timedelta(days=d)).strftime('%m-%d'): [(s['hall'][:8], s['startMin'] // 60) for s in v] for d, v in shows.items() if v})
    print("thresholds:", out["thresholds"], "| fit MAE:", out["meta"]["fitMaeCars"], "| peak:", out["observedPeak"])
    print("kernel per 1000 seats (every 30m from -300):", out["eventKernelPer1000Seats"]["values"])
    print("weekday base (hourly):", [round(float(x)) for x in base_wd[::2]])
    print("weekend base (hourly):", [round(float(x)) for x in base_we[::2]])
    print("exit surge:", out["exitSurge"])


if __name__ == "__main__":
    main()
