import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import type { ForecastBin, Level } from '../../shared/types.ts';
import { LEVEL_LABEL } from '../../shared/types.ts';
import type { DayData } from '../api.ts';
import { nowKstClock, num, toMinutes } from '../format.ts';
import { useWidth } from '../useWidth.ts';
import { shortHall } from './DateStrip.tsx';

const FROM = 6 * 60;
const BIN = 30;

const fill: Record<Level, string> = {
  calm: 'var(--bar-quiet)',
  normal: 'var(--bar-quiet)',
  busy: 'var(--status-serious)',
  jam: 'var(--status-critical)',
};

/** 위쪽만 둥근 막대(바닥은 기준선에 붙어 있다) */
function barPath(x0: number, x1: number, yTop: number, yBase: number): string {
  const h = yBase - yTop;
  const r = Math.min(4, (x1 - x0) / 2, h);
  if (h <= 0.5) return '';
  return `M${x0},${yBase}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x1 - r}Q${x1},${yTop} ${x1},${yTop + r}V${yBase}Z`;
}

const end30 = (t: string) => {
  const m = toMinutes(t) + 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function describe(b: ForecastBin): string {
  const share = Math.round(b.eventShare * 100);
  return `${b.t}~${end30(b.t)} ${LEVEL_LABEL[b.level]}${share >= 5 ? `, 공연 영향 ${share}%` : ''}`;
}

/** 진단의 중심 차트: 30분 단위 주차 수요, 단계 기준선, 공연 시작선 */
export function ForecastChart({ day, isToday }: { day: DayData; isToday: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const [boxRef, W] = useWidth<HTMLDivElement>(720);
  const narrow = W < 480;
  const H = narrow ? 240 : 300;
  const M = { top: 40, right: narrow ? 60 : 76, bottom: 28, left: 4 };
  const bins = day.forecast.bins;
  const th = day.forecast.thresholds;

  const geo = useMemo(() => {
    const pw = W - M.left - M.right;
    const ph = H - M.top - M.bottom;
    const slot = pw / bins.length;
    const bw = Math.min(14, slot * 0.62);
    const maxR = Math.max(1.25, Math.max(...bins.map((b) => b.ratio)) * 1.08);
    const y = (r: number) => M.top + ph - (Math.min(r, maxR) / maxR) * ph;
    const xAt = (t: string) => M.left + ((toMinutes(t) - FROM) / BIN) * slot;
    return { pw, ph, slot, bw, y, xAt, base: M.top + ph };
  }, [bins, W, H, M.top, M.right, M.bottom, M.left]);

  const ticks = narrow ? ['06:00', '12:00', '18:00', '24:00'] : ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '24:00'];
  const peakIndex = bins.findIndex((b) => b.t === day.forecast.peak.t);
  const majorShows = day.shows.filter((s) => s.major);
  const now = isToday ? nowKstClock() : null;
  const nowX = now && toMinutes(now) >= FROM ? geo.xAt(now) : null;
  const thresholds: { key: Level; value: number }[] = [
    { key: 'normal', value: th.normal },
    { key: 'busy', value: th.busy },
    { key: 'jam', value: th.jam },
  ];

  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = active ?? peakIndex;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? bins.length - 1 : Math.max(0, Math.min(bins.length - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
    setActive(next);
  };

  const act = active != null ? bins[active] : null;
  const summary = `가장 붐비는 시간은 ${day.forecast.peak.t}, ${LEVEL_LABEL[day.forecast.peak.level]}입니다.`;

  return (
    <div className="forecast">
      <div className="forecast__bar">
        <ul className="legend" aria-label="범례">
          <li>
            <span className="legend__swatch" style={{ background: 'var(--bar-quiet)' }} />
            여유·보통
          </li>
          <li>
            <span className="legend__swatch" style={{ background: 'var(--status-serious)' }} />
            붐빔
          </li>
          <li>
            <span className="legend__swatch" style={{ background: 'var(--status-critical)' }} />
            매우 붐빔
          </li>
        </ul>
        <button type="button" className="linkbtn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? '차트로 보기' : '표로 보기'}
        </button>
      </div>

      {asTable ? (
        <div className="tablewrap">
          <table className="datatable">
            <caption className="sr-only">시간대별 예상 혼잡 단계</caption>
            <thead>
              <tr>
                <th scope="col">시간</th>
                <th scope="col">예상 단계</th>
                <th scope="col" className="num">
                  공연 영향
                </th>
              </tr>
            </thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.t}>
                  <td>
                    {b.t}~{end30(b.t)}
                  </td>
                  <td>{LEVEL_LABEL[b.level]}</td>
                  <td className="num">{b.eventShare >= 0.05 ? `${Math.round(b.eventShare * 100)}%` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={boxRef}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            role="group"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={onKey}
            onFocus={() => setActive((a) => a ?? peakIndex)}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
          >
            <title id={titleId}>{`시간대별 주차 수요 예측. ${summary} 좌우 방향키로 시간대를 옮길 수 있어요.`}</title>

            {thresholds.map(({ key, value }) => (
              <g key={key} className="chart__threshold">
                <line x1={M.left} x2={M.left + geo.pw} y1={geo.y(value)} y2={geo.y(value)} />
                <text x={M.left + geo.pw + 8} y={geo.y(value) + 4}>
                  {LEVEL_LABEL[key]}
                </text>
              </g>
            ))}
            <line className="chart__baseline" x1={M.left} x2={M.left + geo.pw} y1={geo.base} y2={geo.base} />

            {majorShows.map((s, i) => {
              const x = geo.xAt(s.start);
              const nearRight = x > M.left + geo.pw - 120;
              return (
                <g key={s.id} className="chart__show">
                  <line x1={x} x2={x} y1={M.top - 12 + i * 16} y2={geo.base} />
                  <text x={nearRight ? x - 6 : x + 6} y={M.top - 16 + i * 16} textAnchor={nearRight ? 'end' : 'start'}>
                    {s.start} {shortHall(s.hall)}
                  </text>
                </g>
              );
            })}

            {bins.map((b, i) => {
              const cx = M.left + i * geo.slot + geo.slot / 2;
              return (
                <path
                  key={b.t}
                  d={barPath(cx - geo.bw / 2, cx + geo.bw / 2, geo.y(b.ratio), geo.base)}
                  fill={fill[b.level]}
                  className={`chart__bar${active === i ? ' is-active' : ''}`}
                />
              );
            })}

            {nowX != null && (
              <g className="chart__now">
                <line x1={nowX} x2={nowX} y1={M.top} y2={geo.base} />
                <text x={nowX} y={geo.base + 20} textAnchor="middle">
                  지금
                </text>
              </g>
            )}

            {ticks.map((t) => (
              <text key={t} className="chart__tick" x={t === '24:00' ? M.left + geo.pw : geo.xAt(t)} y={geo.base + 20} textAnchor="middle">
                {t.slice(0, 2)}시
              </text>
            ))}

            {bins.map((b, i) => (
              <rect key={`hit-${b.t}`} x={M.left + i * geo.slot} y={M.top} width={geo.slot} height={geo.ph} fill="transparent" onPointerEnter={() => setActive(i)} />
            ))}
          </svg>

          {act && active != null && (
            <div
              className="tooltip"
              style={{ left: `${((M.left + active * geo.slot + geo.slot / 2) / W) * 100}%`, top: `${(geo.y(act.ratio) / H) * 100}%` }}
              aria-hidden="true"
            >
              <span className="tooltip__value">{LEVEL_LABEL[act.level]}</span>
              <span className="tooltip__label">
                {act.t}~{end30(act.t)}
              </span>
              {act.eventShare >= 0.05 && <span className="tooltip__label">공연 영향 {Math.round(act.eventShare * 100)}%</span>}
            </div>
          )}
          <p className="sr-only" aria-live="polite">
            {act ? describe(act) : ''}
          </p>
        </div>
      )}

      <p className="forecast__note">
        2024년 7월 동2·남2·북2문 실측 대비 상대값이고, 가로선은 단계가 바뀌는 기준이에요. 예측 모델 {day.model.version}
        {day.model.fitMaeCars != null && `, 학습 기간 공연일 평균 오차 ±${num(Math.round(day.model.fitMaeCars))}대`}
      </p>
    </div>
  );
}
