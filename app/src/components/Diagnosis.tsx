import type { DayWeather, ForecastBin, Level } from '../../shared/types.ts';
import { LEVEL_LABEL } from '../../shared/types.ts';
import type { DayData } from '../api.ts';
import { dateLong, num, toMinutes } from '../format.ts';
import { shortHall } from './DateStrip.tsx';
import { ForecastChart } from './ForecastChart.tsx';
import { Card, LevelTag } from './ui.tsx';

const RANK: Record<Level, number> = { calm: 0, normal: 1, busy: 2, jam: 3 };
const plus30 = (t: string) => {
  const m = toMinutes(t) + 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** '붐빔' 이상이 이어지는 구간들 */
export function busyRuns(bins: ForecastBin[]): { from: string; to: string; level: Level; event: boolean }[] {
  const runs: { from: string; to: string; level: Level; share: number[] }[] = [];
  bins.forEach((b, i) => {
    if (RANK[b.level] < RANK.busy) return;
    const last = runs[runs.length - 1];
    if (last && i > 0 && RANK[bins[i - 1].level] >= RANK.busy) {
      last.to = plus30(b.t);
      if (RANK[b.level] > RANK[last.level]) last.level = b.level;
      last.share.push(b.eventShare);
    } else {
      runs.push({ from: b.t, to: plus30(b.t), level: b.level, share: [b.eventShare] });
    }
  });
  return runs.map((r) => ({
    from: r.from,
    to: r.to,
    level: r.level,
    event: r.share.reduce((s, x) => s + x, 0) / r.share.length > 0.25,
  }));
}

/**
 * 가장 붐비는 단계가 이어지는 구간을 제목으로, 그보다 먼저 붐비기 시작하는 시각을 덧붙인다.
 * 대형 공연이 없는 날(usual)은 날짜 띠에 '평소 수준'으로 나오므로, 제목도 매일 반복되는 혼잡임을 밝힌다.
 */
function headline(bins: ForecastBin[], peakT: string, usual: boolean): { text: string; busySince: string | null } {
  const i = Math.max(0, bins.findIndex((b) => b.t === peakT));
  const peak = bins[i];
  if (RANK[peak.level] < RANK.busy) return { text: '종일 크게 붐비지 않을 것으로 보여요', busySince: null };
  let a = i;
  let b = i;
  while (a > 0 && bins[a - 1].level === peak.level) a--;
  while (b < bins.length - 1 && bins[b + 1].level === peak.level) b++;
  let c = a;
  while (c > 0 && RANK[bins[c - 1].level] >= RANK.busy) c--;
  return {
    text: `${usual ? '평소처럼 ' : ''}${bins[a].t}~${plus30(bins[b].t)} ${LEVEL_LABEL[peak.level]} 예상`,
    busySince: c < a ? bins[c].t : null,
  };
}

/**
 * 그날 예보 한 줄: '비 예보 15~21시 · 강수확률 60%', '맑음 예보'.
 * 실시간 카드의 '지금 날씨'와 다를 수 있어서 예보라는 것과 비·눈이 오는 시간대를 함께 적는다.
 */
function forecastLabel(w: DayWeather): string {
  const kind = w.precipType ?? w.sky;
  let text = kind ? `${kind} 예보` : '날씨 예보';
  if (w.precipType && w.precipFrom && w.precipTo) {
    const from = Number(w.precipFrom.slice(0, 2));
    const to = Number(w.precipTo.slice(0, 2));
    text += from === 0 && to === 24 ? ' 종일' : to - from <= 1 ? ` ${from}시쯤` : ` ${from}~${to}시`;
  }
  if (w.rainChance != null && w.rainChance >= 30) text += ` · 강수확률 ${w.rainChance}%`;
  return text;
}

export function Diagnosis({ day, loading, isToday }: { day: DayData | null; loading: boolean; isToday: boolean }) {
  if (!day) {
    return (
      <Card className="diagnosis" title="진단">
        <p className="muted">예측을 불러오는 중이에요</p>
      </Card>
    );
  }
  const { bins, peak } = day.forecast;
  const major = day.shows.filter((s) => s.major);
  const head = headline(bins, peak.t, major.length === 0);
  const minor = day.shows.length - major.length;
  const usualRun = busyRuns(bins).find((r) => !r.event);

  return (
    <Card className={`diagnosis${loading ? ' is-stale' : ''}`} id="diagnosis" title="진단">
      <div className="diagnosis__head">
        <p className="diagnosis__date">
          {dateLong(day.date, day.weekday)}
          {day.holidayName && <span className="diagnosis__holiday">{day.holidayName}</span>}
        </p>
        <h3 className="diagnosis__headline">{head.text}</h3>
        <p className="diagnosis__peak">
          <span>
            가장 붐비는 때 <strong>{peak.t}</strong>
          </span>
          <LevelTag level={peak.level} />
        </p>
        {head.busySince && <p className="diagnosis__since">{head.busySince}부터 붐비기 시작해요</p>}
      </div>

      <ForecastChart day={day} isToday={isToday} />

      <h4 className="causes__title">혼잡 요인</h4>
      <ul className="causes">
        {major.map((s) => (
          <li key={s.id} className="cause cause--event">
            <span className="cause__label">
              {shortHall(s.hall)} {s.start} 공연
            </span>
            <span className="cause__detail">
              {num(s.seats)}석 · {s.name}
            </span>
          </li>
        ))}
        {minor > 0 && (
          <li className="cause">
            <span className="cause__label">소규모 공연 {minor}회</span>
            <span className="cause__detail">2,000석 미만 공연장은 예측에 반영하지 않았어요</span>
          </li>
        )}
        {usualRun && (
          <li className="cause">
            <span className="cause__label">
              {usualRun.from}~{usualRun.to} 평소 혼잡
            </span>
            <span className="cause__detail">
              {day.dayType === 'weekday' ? '평일 오전은 공연이 없어도 붐비는 시간대예요' : '주말 오후는 공연이 없어도 방문객이 많아요'}
            </span>
          </li>
        )}
        {day.dayType === 'holiday' && (
          <li className="cause">
            <span className="cause__label">공휴일</span>
            <span className="cause__detail">주말과 같은 패턴으로 예측했어요</span>
          </li>
        )}
        {day.weather && (
          <li className="cause">
            <span className="cause__label">{forecastLabel(day.weather)}</span>
            <span className="cause__detail">
              최저 {day.weather.minTemp}° · 최고 {day.weather.maxTemp}°, 기상청 단기예보
            </span>
          </li>
        )}
      </ul>
      {day.errors.shows && <p className="notice">공연 정보를 불러오지 못해 평소 패턴만으로 예측했어요</p>}
    </Card>
  );
}
