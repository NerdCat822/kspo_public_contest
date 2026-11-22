import type { ConcertAdvice, DayType, ForecastBin, Level, ParkAdvice, Show, Window } from '../../shared/types.ts';
import { hhmm, toMinutes } from '../time.ts';
import baseline from './baseline.json';

/**
 * v0 예측 모델 (analysis/build_baseline.py 가 만든 baseline.json 사용)
 *
 * 수요(t) = 요일 유형별 기준선(t) + Σ 공연별 (좌석/1000) × 공연 영향 곡선(t - 시작)
 * 단계는 2024년 7월 08~23시 구간 분포의 50/80/95 분위로 나눈다.
 * 단위는 동2·남2·북2문 동시 주차대수(2024년 7월 기준)이며, 화면에는 상대값과 단계만 보여 준다.
 */
const BIN = baseline.binMinutes; // 30
const BINS = (24 * 60) / BIN;
const K_FROM = baseline.eventKernelPer1000Seats.offsetFromStartMinutes;
const KERNEL = baseline.eventKernelPer1000Seats.values;
const { p50, p80, p95 } = baseline.thresholds;

export const THRESHOLDS = { normal: p50 / p95, busy: p80 / p95, jam: 1 };
export const EXIT_MINUTES = baseline.exitSurge.medianMinutesTo80pct ?? 70;
export const MODEL_META = {
  version: baseline.meta.version,
  fitMaeCars: baseline.meta.fitMaeCars,
  exitMinutes: EXIT_MINUTES,
  note: '2024년 7월 동2·남2·북2문 입출차와 KOPIS 공연 일정으로 만든 초기 모델입니다. 2025년 연계 데이터로 다시 학습할 예정입니다.',
};

/** 화면에 보여 주는 시간대(06:00~24:00) */
export const VIEW_FROM = 6 * 60;
export const VIEW_TO = 24 * 60;

const RANK: Record<Level, number> = { calm: 0, normal: 1, busy: 2, jam: 3 };

export function levelOf(cars: number): Level {
  if (cars >= p95) return 'jam';
  if (cars >= p80) return 'busy';
  if (cars >= p50) return 'normal';
  return 'calm';
}

export interface DayForecast {
  bins: ForecastBin[];
  peak: { t: string; level: Level };
}

export function forecastDay(dayType: DayType, shows: Show[]): DayForecast {
  const base = dayType === 'weekday' ? baseline.baseline.weekday : baseline.baseline.weekend;
  const effect = new Array<number>(BINS).fill(0);
  for (const s of shows) {
    if (!s.major) continue;
    const sb = Math.floor(toMinutes(s.start) / BIN);
    KERNEL.forEach((k, i) => {
      const b = sb + K_FROM / BIN + i;
      if (b >= 0 && b < BINS) effect[b] += (k * s.seats) / 1000;
    });
  }

  const bins: ForecastBin[] = [];
  for (let b = VIEW_FROM / BIN; b < VIEW_TO / BIN; b++) {
    const cars = base[b] + effect[b];
    bins.push({
      t: hhmm(b * BIN),
      level: levelOf(cars),
      ratio: Math.round((cars / p95) * 1000) / 1000,
      eventShare: cars > 0 ? Math.round((effect[b] / cars) * 100) / 100 : 0,
    });
  }
  const peakBin = bins.reduce((m, x) => (x.ratio > m.ratio ? x : m), bins[0]);
  return { bins, peak: { t: peakBin.t, level: peakBin.level } };
}

const roundDown15 = (min: number) => Math.floor(min / 15) * 15;

/** 공연 관람객 처방: 언제까지 도착하면 수월한지, 끝나고 언제 출차가 몰리는지 */
export function concertAdvice(show: Show, bins: ForecastBin[]): ConcertAdvice {
  const start = toMinutes(show.start);
  const within = bins.filter((b) => {
    const t = toMinutes(b.t);
    return t >= start - 180 && t < start - 30;
  });
  const firstBusy = within.find((b) => RANK[b.level] >= RANK.busy) ?? null;
  // 공연 3시간 전부터 이미 붐비면 차로 일찍 오는 것보다 대중교통이 현실적이다.
  const transitFirst = firstBusy != null && firstBusy === within[0];
  const arriveBy = firstBusy ? hhmm(roundDown15(toMinutes(firstBusy.t) - 15)) : hhmm(roundDown15(start - 45));
  const end = toMinutes(show.end);
  return {
    showId: show.id,
    arriveBy,
    busyFrom: firstBusy?.t ?? null,
    start: show.start,
    end: show.end,
    exitRush: { from: hhmm(end), to: hhmm(end + EXIT_MINUTES) },
    transitFirst,
  };
}

/** 공원 방문객 처방: 08~20시 중 덜 붐비는 시간대와 피할 시간대 */
export function parkAdvice(bins: ForecastBin[]): ParkAdvice {
  const day = bins.filter((b) => toMinutes(b.t) >= 8 * 60 && toMinutes(b.t) < 20 * 60);
  const runs: { from: number; to: number; items: ForecastBin[] }[] = [];
  for (const b of day) {
    const t = toMinutes(b.t);
    const quiet = RANK[b.level] <= RANK.normal;
    const last = runs[runs.length - 1];
    if (last && last.to === t && (RANK[last.items[0].level] <= RANK.normal) === quiet) {
      last.to = t + BIN;
      last.items.push(b);
    } else {
      runs.push({ from: t, to: t + BIN, items: [b] });
    }
  }
  const mean = (r: { items: ForecastBin[] }, f: (b: ForecastBin) => number) => r.items.reduce((s, b) => s + f(b), 0) / r.items.length;
  const toWindow = (r: { from: number; to: number }): Window => ({ from: hhmm(r.from), to: hhmm(r.to) });

  const best = runs
    .filter((r) => RANK[r.items[0].level] <= RANK.normal && r.items.length >= 2)
    .sort((p, q) => mean(p, (b) => b.ratio) - mean(q, (b) => b.ratio) || q.items.length - p.items.length)
    .slice(0, 2)
    .sort((p, q) => p.from - q.from)
    .map(toWindow);

  const avoid = runs
    .filter((r) => RANK[r.items[0].level] >= RANK.busy)
    .map((r) => ({ ...toWindow(r), reason: mean(r, (b) => b.eventShare) > 0.25 ? ('event' as const) : ('usual' as const) }));

  return { best, avoid };
}
