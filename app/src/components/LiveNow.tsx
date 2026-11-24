import type { LiveResponse } from '../../shared/types.ts';
import { clock, km, num, shortStamp, toMinutes } from '../format.ts';
import { Card, Icon, Tag, populationTone, roadTone } from './ui.tsx';

/** 오늘 모은 기록 중 1시간 전에 가장 가까운 값과 비교한다(25~120분 전 기록만, 없으면 표시하지 않음). */
function parkingDelta(today: { at: string; sum: number }[], now: { at: string; sum: number }): string | null {
  const nowMin = toMinutes(clock(now.at));
  let best: { sum: number; ago: number } | null = null;
  for (const r of today) {
    const ago = nowMin - toMinutes(clock(r.at));
    if (ago < 25 || ago > 120) continue;
    if (!best || Math.abs(ago - 60) < Math.abs(best.ago - 60)) best = { sum: r.sum, ago };
  }
  if (!best) return null;
  const diff = now.sum - best.sum;
  const when = Math.abs(best.ago - 60) <= 5 ? '1시간 전' : `${best.ago}분 전`;
  if (diff === 0) return `${when}과 같아요`;
  return `${when}보다 ${signed(diff)}`;
}

const signed = (diff: number) => `${diff > 0 ? '+' : '−'}${num(Math.abs(diff))}대`;

/** 평소 이 시각(대형 공연이 없던 같은 유형의 날 평균)과 비교한다. 기준이 없으면 표시하지 않는다. */
function usualDelta(p: NonNullable<LiveResponse['parking']>): string | null {
  if (!p.usual) return null;
  const diff = p.sum - p.usual.sum;
  return diff === 0 ? '평소 이 시각과 같아요' : `평소 이 시각보다 ${signed(diff)}`;
}

export function LiveNow({ live }: { live: LiveResponse | null }) {
  const p = live?.parking;
  const road = live?.road;
  const pop = live?.population;
  const w = live?.weather;
  const deltas = p ? [usualDelta(p), parkingDelta(p.today, p)].filter((d): d is string => d !== null) : [];

  return (
    <Card className="live" id="live" title="지금 올림픽공원" aside={live ? <span className="meta">{clock(live.fetchedAt)} 기준</span> : null}>
      <div className="tiles">
        <div className="tile tile--wide">
          <p className="tile__label">실시간 주차, 동2·남2·북2문 합계</p>
          <p className="tile__value">{p ? `${num(p.sum)}대` : '–'}</p>
          {deltas.length > 0 && <p className="tile__delta">{deltas.join(' · ')}</p>}
          <p className="tile__note">
            {p?.usual &&
              `평소는 대형 공연이 없던 최근 ${p.usual.dayType === 'weekday' ? '평일' : '주말·공휴일'} ${p.usual.days}일의 같은 시각 평균(${num(p.usual.sum)}대)이에요. `}
            장기주차 차량이 포함돼 실제보다 많게 집계될 수 있어요
          </p>
        </div>

        <div className="tile">
          <p className="tile__label">주변 도로</p>
          <p className="tile__value">{road ? `${road.speed}km/h` : '–'}</p>
          {road && <Tag tone={roadTone(road.level)}>{road.level}</Tag>}
        </div>

        <div className="tile">
          <p className="tile__label">공원 인구</p>
          <p className="tile__value">{pop ? <Tag tone={populationTone(pop.level)}>{pop.level}</Tag> : '–'}</p>
          {pop && (
            <p className="tile__sub">
              {num(pop.min)}~{num(pop.max)}명
            </p>
          )}
        </div>

        <div className="tile">
          <p className="tile__label">지금 날씨</p>
          <p className="tile__value">{w ? `${w.temp}°` : '–'}</p>
          {w && <p className="tile__sub">{w.precipType !== '없음' ? w.precipType : w.sky ?? '맑음'}</p>}
        </div>
      </div>

      {pop && pop.forecast.length > 0 && (
        <div className="popfcst">
          <p className="popfcst__label">공원 인구 12시간 예측</p>
          <ol className="popfcst__cells">
            {pop.forecast.map((f) => (
              <li key={f.at} className={`tone-${populationTone(f.level)}`} title={`${clock(f.at)} ${f.level}`}>
                <span className="sr-only">
                  {clock(f.at)} {f.level}
                </span>
              </li>
            ))}
          </ol>
          <div className="popfcst__axis" aria-hidden="true">
            <span>{clock(pop.forecast[0].at)}</span>
            <span>{clock(pop.forecast[pop.forecast.length - 1].at)}</span>
          </div>
        </div>
      )}

      {live && Object.keys(live.errors).length > 0 && (
        <p className="notice">일부 실시간 정보를 불러오지 못했어요: {Object.keys(live.errors).map(errorName).join(', ')}</p>
      )}
    </Card>
  );
}

const errorName = (k: string) => ({ parking: '주차', city: '서울시 도시데이터', controls: '돌발정보' })[k] ?? k;

export function Controls({ live }: { live: LiveResponse | null }) {
  const list = live?.controls ?? [];
  return (
    <Card className="controls" id="controls" title="공사·통제" aside={<span className="meta">반경 3km</span>}>
      {list.length === 0 ? (
        <p className="muted">지금은 주변에 공사나 통제 정보가 없어요</p>
      ) : (
        <ul className="controls__list">
          {list.slice(0, 6).map((c) => (
            <li key={c.id}>
              <span className="controls__kind">
                <Icon.alert />
                {c.kind}
              </span>
              <span className="controls__info">{c.info}</span>
              <span className="controls__meta">
                {km(c.distanceM)}
                {c.to && ` · ${shortStamp(c.to)}까지`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Lots({ live }: { live: LiveResponse | null }) {
  const lots = [...(live?.lots ?? [])].sort((a, b) => b.capacity - a.capacity);
  if (!lots.length) return null;
  return (
    <Card className="lots" id="lots" title="주변 공영주차장">
      <table className="datatable">
        <thead>
          <tr>
            <th scope="col">주차장</th>
            <th scope="col" className="num">
              면수
            </th>
            <th scope="col" className="num">
              요금
            </th>
          </tr>
        </thead>
        <tbody>
          {lots.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="num">{num(l.capacity)}</td>
              <td className="num">{l.fee ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="caption">실시간 빈자리는 제공되지 않아 면수만 보여 드려요</p>
    </Card>
  );
}
