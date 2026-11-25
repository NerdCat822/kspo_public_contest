"""2025년 한국체육산업개발 입출차정보(전체구역)와 KOPIS 공연 일정으로 v1 예측 모델을 만들고,
학습에 쓰지 않은 기간으로 오차를 잰다.

사용법:
    python3 analysis/fetch_kcisa.py .env inout && python3 analysis/fetch_kcisa.py .env linked
    python3 analysis/load_kcisa.py .env
    python3 analysis/fetch_kopis_events.py .env 20250101 20251231 data/derived/kopis_events_2025.json
    python3 analysis/build_model_v1.py .env data/derived/kopis_events_2025.json \\
        ai/models/baseline-v1.json data/derived/validation_v1.json
    cp ai/models/baseline-v1.json backend/internal/model/baseline.json

모델 형태는 v0 와 같다(Go·Python 서비스가 같은 파일을 그대로 읽는다).
    수요(t) = 요일 유형별 기준선(t) + Σ 대형 공연별 (좌석/1000) × 공연 영향 곡선(t - 시작)

방법
1. 입출차 원본(gilmak.kspo_inout_2025)에서 동2·남2·북2문으로 들어온 차의 분 단위 동시 주차대수를 구하고 30분 평균을 낸다.
   실시간 주차현황 API 가 이 세 구역의 합계라서 같은 범위를 쓴다. 출차가 입차보다 이르거나 24시간 넘게 머문 차(장기주차)는 뺀다.
2. 입차 건수가 같은 요일 유형 중앙값의 절반이 안 되는 날(데이터 누락)과 1월 1일(전년도에 들어온 차를 모름)은 뺀다.
3. 공휴일(연계 데이터의 휴일 표기)과 토·일은 '주말', 나머지는 '평일'로 묶는다(서비스와 같은 기준).
4. 대형 공연(2,000석 이상 공연장)은 KOPIS 공연상세의 요일별 시작 시각으로 날짜별로 펼친다.
   KOPIS 에는 없는데 연계 데이터에 관람객 2,000명 이상 공연·행사가 잡힌 날은 '알 수 없는 행사일'로 보고 학습에서 뺀다.
5. 평일 기준선은 대형 공연과 알 수 없는 행사가 없는 평일의 평균이다. 2025년은 공연 없는 주말이 며칠 안 돼서,
   주말 기준선과 좌석 1,000석당 공연 영향 곡선은 주말 전체와 공연 있는 평일로 함께 최소제곱 추정한다(2차 차분 평활).
6. 검증: SPLIT 이전 날짜로 학습하고 그 뒤 날짜로 08:00~23:30 구간 평균 절대 오차를 잰다(시간 분할).
   같은 날짜로 v0 모델(2024년 7월)과 '기준선만'(공연 영향 없이)도 함께 잰다.
7. 최종 모델은 2025년 전체로 다시 학습한다. 혼잡 단계 기준은 08:00~23:30 구간 분포의 50/80/95 분위.
8. 공연 종료 후 출차 집중: KSPO DOME 공연마다 평소 대비 초과 출차의 80%가 빠지기까지 걸린 시간의 중앙값.
"""
import datetime as dt
import json
import os
import sys

import numpy as np
import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_baseline import MAJOR_MIN_SEATS, hall_of, parse_runtime, parse_schedule  # noqa: E402

BIN = 30
BPD = 24 * 60 // BIN  # 하루 구간 수(48)
EVAL = slice(16, 47)  # 08:00~23:30 구간(v0 와 같은 범위)
KERNEL_FROM, KERNEL_TO = -300, 360
ZONES = ("동2문", "남2문", "북2문")  # 실시간 주차현황 API 가 합계로 주는 구역
MAX_STAY = 24 * 60
T0 = dt.date(2025, 1, 1)
NDAYS = 365
SPLIT = dt.date(2025, 9, 1)  # 이 날부터는 검증용(학습에 쓰지 않음)
UNKNOWN_EVENT_AUDIENCE = 2000


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def day_of(i):
    return T0 + dt.timedelta(days=i)


def label(d):
    return d.strftime("%Y-%m-%d")


def read_inout(cur):
    """분 단위 입차·출차 누적용 배열(동2·남2·북2문)과 날짜별 입차 건수(전체 문)."""
    horizon = (NDAYS + 2) * 1440
    enter = np.zeros(horizon + 1, dtype=np.int64)
    leave = np.zeros(horizon + 1, dtype=np.int64)
    exits10 = np.zeros(horizon // 10 + 1, dtype=np.int64)
    entries_all = np.zeros(NDAYS + 2, dtype=np.int64)
    stats = {"rows": 0, "used": 0, "negative": 0, "noExit": 0, "longStay": 0, "otherZones": 0}
    cur.itersize = 200_000
    cur.execute("""
        SELECT (extract(epoch FROM entry_at - timestamptz '2025-01-01 00:00:00+09') / 60)::bigint,
               (extract(epoch FROM exit_at  - timestamptz '2025-01-01 00:00:00+09') / 60)::bigint,
               entry_zone IN ('동2문', '남2문', '북2문')
        FROM gilmak.kspo_inout_2025""")
    while True:
        rows = cur.fetchmany(200_000)
        if not rows:
            break
        a = np.array([r[0] for r in rows], dtype=np.int64)
        b = np.array([r[1] if r[1] is not None else -1 for r in rows], dtype=np.int64)
        has_exit = np.array([r[1] is not None for r in rows])
        z3 = np.array([bool(r[2]) for r in rows])
        stats["rows"] += len(rows)
        inside = (a >= 0) & (a < NDAYS * 1440)
        np.add.at(entries_all, a[inside] // 1440, 1)
        stats["noExit"] += int((~has_exit).sum())
        neg = has_exit & (b < a)
        long = has_exit & (b - a > MAX_STAY)
        stats["negative"] += int(neg.sum())
        stats["longStay"] += int(long.sum())
        stats["otherZones"] += int((~z3).sum())
        ok = inside & has_exit & ~neg & ~long & z3
        stats["used"] += int(ok.sum())
        np.add.at(enter, a[ok], 1)
        np.add.at(leave, np.minimum(b[ok], horizon), 1)
        np.add.at(exits10, np.minimum(b[ok], horizon) // 10, 1)
    conc = np.cumsum(enter - leave)[: NDAYS * 1440]
    occ = conc.reshape(NDAYS, BPD, BIN).mean(axis=2)
    ex10 = exits10[: NDAYS * 144].reshape(NDAYS, 144)
    return occ, ex10, entries_all[:NDAYS], conc, stats


def read_linked(cur):
    """날짜별 휴일 이름과, 그날 연계 데이터에 잡힌 공연·행사 관람객 수의 최댓값."""
    cur.execute("""SELECT (observed_at AT TIME ZONE 'Asia/Seoul')::date, max(holiday), max(coalesce(audience, 0)), string_agg(DISTINCT shows, ' | ')
                   FROM gilmak.kspo_linked_2025 GROUP BY 1""")
    holidays, audience, names = {}, {}, {}
    for d, hol, aud, shows in cur.fetchall():
        i = (d - T0).days
        if 0 <= i < NDAYS:
            if hol:
                holidays[i] = hol
            audience[i] = aud or 0
            names[i] = shows or ""
    return holidays, audience, names


def shows_by_day(events_path, holidays):
    ev = json.load(open(events_path, encoding="utf-8"))
    halls = ev["halls"]
    out = {i: [] for i in range(NDAYS)}
    for e in ev["events"]:
        hall = hall_of(e["facility"], halls)
        if not hall or hall["seats"] < MAJOR_MIN_SEATS:
            continue
        sched = parse_schedule(e["schedule"])
        start = dt.datetime.strptime(e["from"], "%Y.%m.%d").date()
        end = dt.datetime.strptime(e["to"], "%Y.%m.%d").date()
        for i in range(NDAYS):
            day = day_of(i)
            if not (start <= day <= end):
                continue
            times = sched.get(day.weekday(), [])
            if i in holidays and sched.get("HOL"):
                times = sched["HOL"]
            for t in times:
                hh, mm = map(int, t.split(":"))
                rt = parse_runtime(e["runtime"])
                out[i].append({"name": e["name"], "hall": hall["name"], "seats": hall["seats"], "startMin": hh * 60 + mm,
                               "runtime": rt or 150, "runtimeKnown": rt is not None})
    return out


class Model:
    def __init__(self, base_wd, base_we, kernel):
        self.base_wd, self.base_we, self.kernel = base_wd, base_we, kernel
        self.k_bins = list(range(KERNEL_FROM // BIN, KERNEL_TO // BIN + 1))

    def effect(self, day_shows):
        out = np.zeros(BPD)
        for s in day_shows:
            sb = s["startMin"] // BIN
            for j, o in enumerate(self.k_bins):
                if 0 <= sb + o < BPD:
                    out[sb + o] += self.kernel[j] * s["seats"] / 1000
        return out

    def predict(self, weekend, day_shows, with_shows=True):
        base = self.base_we if weekend else self.base_wd
        return base + (self.effect(day_shows) if with_shows else 0)


def fit(occ, days, weekend, shows, quiet):
    """평일 기준선은 공연·행사 없는 평일 평균으로 둔다(날이 많다).
    2025년 주말은 대부분 대형 공연이 있어 공연 없는 주말이 며칠 안 된다. 그래서 v0 처럼 주말 기준선과
    좌석 1,000석당 공연 영향 곡선을 공연 없는 주말 + 공연 있는 주말 + 공연 있는 평일로 함께 최소제곱 추정한다.
        공연 없는 주말 d:  occ[d,b]               = base_we[b]
        공연 있는 주말 d:  occ[d,b]               = base_we[b] + Σ (좌석/1000) × kernel[b - 시작구간]
        공연 있는 평일 d:  occ[d,b] - base_wd[b]  =              Σ (좌석/1000) × kernel[b - 시작구간]
    공연 시작 시각과 규모가 날마다 달라 두 성분을 나눌 수 있다. 둘 다 2차 차분으로 평활한다."""
    wd = [d for d in days if quiet[d] and not weekend[d]]
    we_quiet = [d for d in days if quiet[d] and weekend[d]]
    base_wd = occ[wd].mean(axis=0)
    k_bins = list(range(KERNEL_FROM // BIN, KERNEL_TO // BIN + 1))
    K = len(k_bins)
    n_var = BPD + K
    A, y = [], []
    show_days = [d for d in days if shows[d]]
    rows_days = [d for d in days if weekend[d] and (quiet[d] or shows[d])] + [d for d in show_days if not weekend[d]]
    for d in rows_days:
        for b in range(BPD):
            row = np.zeros(n_var)
            if weekend[d]:
                row[b] = 1.0
            for s in shows[d]:
                j = b - s["startMin"] // BIN - k_bins[0]
                if 0 <= j < K:
                    row[BPD + j] += s["seats"] / 1000
            A.append(row)
            y.append(occ[d][b] if weekend[d] else occ[d][b] - base_wd[b])
    lam = 3.0 * np.sqrt(max(1, len(rows_days)) / 9)  # v0(공연일 9일)와 같은 평활 비중이 되게 날 수에 맞춘다
    for offset, size in ((0, BPD), (BPD, K)):
        for j in range(1, size - 1):
            row = np.zeros(n_var)
            row[offset + j - 1], row[offset + j], row[offset + j + 1] = lam, -2 * lam, lam
            A.append(row)
            y.append(0.0)
    for j in (0, K - 1):  # 영향 범위 양 끝은 0
        row = np.zeros(n_var)
        row[BPD + j] = 10.0 * lam
        A.append(row)
        y.append(0.0)
    sol, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
    base_we = np.clip(sol[:BPD], 0, None)
    kernel = np.clip(sol[BPD:], 0, None)
    stats = {"baseWeekdays": len(wd), "baseWeekendDays": len(we_quiet),
             "weekendDaysUsed": sum(1 for d in rows_days if weekend[d]), "showDays": len(show_days)}
    return Model(base_wd, base_we, kernel), stats


def thresholds(occ, days):
    v = occ[days][:, EVAL].ravel()
    return tuple(float(np.percentile(v, q)) for q in (50, 80, 95))


def level(x, th):
    p50, p80, p95 = th
    return np.where(x >= p95, 3, np.where(x >= p80, 2, np.where(x >= p50, 1, 0)))


def v0_predict(v0, weekend, day_shows):
    base = np.array(v0["baseline"]["weekend" if weekend else "weekday"])
    k = v0["eventKernelPer1000Seats"]
    out = base.copy()
    for s in day_shows:
        sb = s["startMin"] // BIN
        for j, val in enumerate(k["values"]):
            b = sb + k["offsetFromStartMinutes"] // BIN + j
            if 0 <= b < BPD:
                out[b] += val * s["seats"] / 1000
    return out


def exit_surge(ex10, days, weekend, shows, quiet):
    base_wd = ex10[[d for d in days if quiet[d] and not weekend[d]]].mean(axis=0)
    base_we = ex10[[d for d in days if quiet[d] and weekend[d]]].mean(axis=0)
    rows = []
    for d in days:
        for s in shows[d]:
            if s["seats"] < 10000 or not s["runtimeKnown"]:
                continue
            base = base_we if weekend[d] else base_wd
            end_bin = (s["startMin"] + s["runtime"]) // 10
            window = [b for b in range(end_bin - 3, end_bin + 19) if b < 144]
            excess = np.clip([ex10[d][b] - base[b] for b in window], 0, None)
            if excess.sum() < 100:  # 출차가 거의 늘지 않은 회차(같은 날 앞 회차 등)는 뺀다
                continue
            cum = np.cumsum(excess) / excess.sum()
            rows.append({"date": label(day_of(d)), "name": s["name"], "hall": s["hall"],
                         "endEstimate": f"{(s['startMin'] + s['runtime']) // 60:02d}:{(s['startMin'] + s['runtime']) % 60:02d}",
                         "minutesTo80pct": (int(np.argmax(cum >= 0.8)) - 3) * 10, "excessExits": int(excess.sum())})
    return rows


def mae(pred, actual):
    return float(np.mean(np.abs(pred[EVAL] - actual[EVAL])))


def main():
    env_path, events_path, out_model, out_report = sys.argv[1:5]
    env = load_env(env_path)
    conn = psycopg2.connect(env["DATABASE_URL"])
    cur = conn.cursor(name="inout")  # 서버 쪽 커서로 나눠 읽는다
    occ, ex10, entries, conc, stats = read_inout(cur)
    cur.close()
    cur = conn.cursor()
    holidays, audience, linked_names = read_linked(cur)
    conn.close()

    weekend = {i: day_of(i).weekday() >= 5 or i in holidays for i in range(NDAYS)}
    shows = shows_by_day(events_path, holidays)
    unknown_event = {i: not shows[i] and audience.get(i, 0) >= UNKNOWN_EVENT_AUDIENCE for i in range(NDAYS)}
    quiet = {i: not shows[i] and not unknown_event[i] for i in range(NDAYS)}

    # 데이터가 빠진 날 빼기
    med = {w: np.median([entries[i] for i in range(NDAYS) if weekend[i] == w and entries[i] > 0]) for w in (False, True)}
    ok = [i for i in range(1, NDAYS) if entries[i] >= 0.5 * med[weekend[i]] and entries[i - 1] >= 0.5 * med[weekend[i - 1]]]
    missing = [label(day_of(i)) for i in range(NDAYS) if i not in ok]
    train = [i for i in ok if day_of(i) < SPLIT]
    test = [i for i in ok if day_of(i) >= SPLIT]

    # ── 시간 분할 검증
    m_train, fit_stats = fit(occ, train, weekend, shows, quiet)
    th_train = thresholds(occ, train)
    v0 = json.load(open("ai/models/baseline-v0.json", encoding="utf-8"))
    th_v0 = (v0["thresholds"]["p50"], v0["thresholds"]["p80"], v0["thresholds"]["p95"])
    per_day = []
    for d in test:
        actual = occ[d]
        pred = m_train.predict(weekend[d], shows[d])
        base_only = m_train.predict(weekend[d], shows[d], with_shows=False)
        p_v0 = v0_predict(v0, weekend[d], shows[d])
        lv_a, lv_p = level(actual[EVAL], th_train), level(pred[EVAL], th_train)
        kind = "show" if shows[d] else ("unknown" if unknown_event[d] else "quiet")
        per_day.append({
            "date": label(day_of(d)), "weekend": weekend[d], "kind": kind,
            "shows": [f"{s['startMin'] // 60:02d}:{s['startMin'] % 60:02d} {s['hall']} {s['seats']}" for s in shows[d]],
            "linkedEvents": linked_names.get(d, "") if kind == "unknown" else "",
            "maeV1": round(mae(pred, actual), 1), "maeBaseOnly": round(mae(base_only, actual), 1), "maeV0": round(mae(p_v0, actual), 1),
            "levelAgreement": round(float(np.mean(lv_a == lv_p)), 3),
            "levelWithinOne": round(float(np.mean(np.abs(lv_a - lv_p) <= 1)), 3),
            "actualPeak": [round(float(actual.max())), f"{int(actual.argmax()) * BIN // 60:02d}:{int(actual.argmax()) * BIN % 60:02d}"],
            "predPeak": [round(float(pred.max())), f"{int(pred.argmax()) * BIN // 60:02d}:{int(pred.argmax()) * BIN % 60:02d}"],
            "peakLevelMatch": bool(level(np.array([actual.max()]), th_train)[0] == level(np.array([pred.max()]), th_train)[0]),
        })

    def summary(kind=None):
        rows = [r for r in per_day if kind is None or r["kind"] == kind]
        if not rows:
            return None
        avg = lambda k: round(float(np.mean([r[k] for r in rows])), 1)  # noqa: E731
        out = {"days": len(rows), "maeV1": avg("maeV1"), "maeBaseOnly": avg("maeBaseOnly"), "maeV0": avg("maeV0"),
               "levelAgreement": round(float(np.mean([r["levelAgreement"] for r in rows])), 3),
               "levelWithinOne": round(float(np.mean([r["levelWithinOne"] for r in rows])), 3)}
        if kind == "show":
            out["peakLevelMatch"] = round(float(np.mean([r["peakLevelMatch"] for r in rows])), 3)
            out["peakTimeErrorMinutesMedian"] = int(np.median([
                abs(int(r["actualPeak"][1][:2]) * 60 + int(r["actualPeak"][1][3:]) - int(r["predPeak"][1][:2]) * 60 - int(r["predPeak"][1][3:]))
                for r in rows]))
        return out

    validation = {"all": summary(), "show": summary("show"), "quiet": summary("quiet"), "unknown": summary("unknown")}

    # ── 최종 모델: 2025년 전체
    model, final_stats = fit(occ, ok, weekend, shows, quiet)
    th = thresholds(occ, ok)
    fit_mae = [mae(model.predict(weekend[d], shows[d]), occ[d]) for d in ok if shows[d]]
    exits = exit_surge(ex10, ok, weekend, shows, quiet)
    exit_median = int(np.median([r["minutesTo80pct"] for r in exits])) if exits else None
    peak_i = int(np.argmax(conc))
    first, last = label(day_of(ok[0])), label(day_of(ok[-1]))
    test_from, test_to = label(day_of(test[0])), label(day_of(test[-1]))
    show_mae = validation["show"]["maeV1"] if validation["show"] else None

    out = {
        "meta": {
            "version": "v1-2025",
            "source": "한국체육산업개발 올림픽공원 입출차정보(전체구역) 2025년(동2·남2·북2문) + 차량입출차·공연·날씨 연계 데이터(휴일·행사) + KOPIS 공연상세",
            "rows": stats["rows"],
            "rowsUsed": stats["used"],
            "excluded": {k: stats[k] for k in ("negative", "noExit", "longStay", "otherZones")},
            "period": "2025년",
            "days": len(ok),
            "missingDays": len(missing),
            "baseWeekdays": final_stats["baseWeekdays"],
            "baseWeekendDays": final_stats["baseWeekendDays"],
            "weekendDaysUsed": final_stats["weekendDaysUsed"],
            "eventDaysUsed": final_stats["showDays"],
            "fitMaeCars": round(float(np.mean(fit_mae)), 1) if fit_mae else None,
            "testMaeCars": show_mae,
            "testPeriod": f"{test_from}~{test_to}",
            "testLabel": f"2025년 {day_of(test[0]).month}~{day_of(test[-1]).month}월",
            "trainPeriod": f"{first}~{label(day_of(train[-1]))}",
            "majorHallMinSeats": MAJOR_MIN_SEATS,
            "note": "한국체육산업개발 2025년 입출차 실측(동2·남2·북2문)과 KOPIS 공연 일정으로 학습한 모델이라 실제와 다를 수 있어요. 공연마다 다른 관객의 차량 이용률은 아직 반영하지 못했어요.",
        },
        "binMinutes": BIN,
        "baseline": {"weekday": [round(float(x), 1) for x in model.base_wd], "weekend": [round(float(x), 1) for x in model.base_we]},
        "eventKernelPer1000Seats": {"offsetFromStartMinutes": KERNEL_FROM, "values": [round(float(x), 2) for x in model.kernel]},
        "thresholds": {"p50": round(th[0], 1), "p80": round(th[1], 1), "p95": round(th[2], 1)},
        "exitSurge": {"medianMinutesTo80pct": exit_median, "showsUsed": len(exits), "shows": exits},
        "observedPeak": {"cars": int(conc[peak_i]), "at": (dt.datetime.combine(T0, dt.time()) + dt.timedelta(minutes=peak_i)).strftime("%Y-%m-%d %H:%M")},
    }
    json.dump(out, open(out_model, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    report = {
        "split": {"train": f"{first}~{label(day_of(train[-1]))}", "test": f"{test_from}~{test_to}", "trainDays": len(train), "testDays": len(test),
                  "trainFit": fit_stats, "thresholdsTrain": [round(x, 1) for x in th_train], "thresholdsV0": th_v0},
        "data": {**stats, "daysOk": len(ok), "missingDays": missing, "medianEntries": {"weekday": float(med[False]), "weekend": float(med[True])}},
        "validation": validation,
        "perDay": per_day,
    }
    json.dump(report, open(out_report, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"입출차 {stats['rows']:,}행 중 {stats['used']:,}행 사용 | 제외: {out['meta']['excluded']}")
    print(f"쓸 수 있는 날 {len(ok)}일({first}~{last}), 빠진 날 {len(missing)}일: {missing[:12]}{' …' if len(missing) > 12 else ''}")
    print(f"학습 {len(train)}일 / 검증 {len(test)}일({test_from}~{test_to}) | 학습 공연일 {fit_stats['showDays']}일")
    for k, v in validation.items():
        print(f"  검증 {k:8s}: {v}")
    print("최종 모델 기준:", out["thresholds"], "| 학습 기간 공연일 오차", out["meta"]["fitMaeCars"], "| 관측 최고", out["observedPeak"])
    print(f"공연 후 출차 80% 소요 중앙값 {exit_median}분 (KSPO DOME {len(exits)}회)")
    print("공연 영향 곡선(1,000석당, -300분부터 30분 간격):", out["eventKernelPer1000Seats"]["values"])
    print("평일 기준선(시간별):", [round(float(x)) for x in model.base_wd[::2]])
    print("주말 기준선(시간별):", [round(float(x)) for x in model.base_we[::2]])


if __name__ == "__main__":
    main()
