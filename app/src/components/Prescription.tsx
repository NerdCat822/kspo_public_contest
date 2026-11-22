import type { Level, Show, Station } from '../../shared/types.ts';
import type { DayData } from '../api.ts';
import { num, toMinutes } from '../format.ts';
import { shortHall } from './DateStrip.tsx';
import { Card, Icon, LevelTag, Plate } from './ui.tsx';

export type Purpose = 'concert' | 'park';

interface Props {
  day: DayData | null;
  stations: Station[];
  purpose: Purpose;
  onPurpose: (p: Purpose) => void;
  showId: string | null;
  onShow: (id: string) => void;
}

const RANK: Record<Level, number> = { calm: 0, normal: 1, busy: 2, jam: 3 };

/** 같은 역의 호선을 묶는다: 올림픽공원(9) + 올림픽공원(한국체대)(5) → 올림픽공원역 5·9호선 */
function stationGroups(stations: Station[]): { name: string; note: string | null; lines: string[] }[] {
  const groups = new Map<string, { name: string; note: string | null; lines: Set<string> }>();
  for (const s of stations) {
    const base = s.name.replace(/\(.*\)$/, '');
    const note = s.name.match(/\((.*)\)$/)?.[1] ?? null;
    const g = groups.get(base) ?? { name: `${base}역`, note: null, lines: new Set<string>() };
    if (note && note !== '한국체대') g.note = note;
    g.lines.add(s.line);
    groups.set(base, g);
  }
  return [...groups.values()].map((g) => ({ ...g, lines: [...g.lines].sort() }));
}

export function Prescription({ day, stations, purpose, onPurpose, showId, onShow }: Props) {
  if (!day) {
    return (
      <Card className="rx" title="처방">
        <p className="muted">예측을 불러오는 중이에요</p>
      </Card>
    );
  }
  const shows = day.shows;
  const hasShows = shows.length > 0;
  const mode: Purpose = hasShows ? purpose : 'park';
  const show = shows.find((s) => s.id === showId) ?? shows[0];
  const advice = show ? day.advice.concert.find((a) => a.showId === show.id) : undefined;

  return (
    <Card
      className="rx"
      id="rx"
      title="처방"
      aside={
        hasShows ? (
          <div className="segmented" role="group" aria-label="방문 목적">
            <button type="button" aria-pressed={mode === 'concert'} onClick={() => onPurpose('concert')}>
              공연 보러 가요
            </button>
            <button type="button" aria-pressed={mode === 'park'} onClick={() => onPurpose('park')}>
              공원에 가요
            </button>
          </div>
        ) : null
      }
    >
      {mode === 'concert' && show && advice ? (
        <>
          {shows.length > 1 && <ShowPicker shows={shows} selectedId={show.id} onShow={onShow} />}

          <ol className="steps">
            <li className="step">
              <span className="step__icon">{advice.transitFirst ? <Icon.train /> : <Icon.car />}</span>
              <div className="step__body">
                <p className="step__kicker">가는 길</p>
                {advice.transitFirst ? (
                  <>
                    <p className="step__hero">지하철을 권해요</p>
                    <p className="step__text">
                      공연 3시간 전인 {advice.busyFrom}부터 주차장이 붐빌 것으로 보여요. 차로 온다면 <Plate size="sm">{advice.arriveBy}</Plate> 전에 도착해야
                      여유가 있어요.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="step__hero">
                      <Plate>{advice.arriveBy}</Plate> 전에 도착하세요
                    </p>
                    <p className="step__text">
                      {advice.busyFrom
                        ? `${advice.busyFrom}부터 주차장이 붐비기 시작해요. 공연은 ${advice.start}에 시작해요.`
                        : `공연 시작(${advice.start}) 45분 전까지 와도 여유가 있을 것으로 보여요.`}
                    </p>
                  </>
                )}
              </div>
            </li>

            <li className="step">
              <span className="step__icon">
                <Icon.exit />
              </span>
              <div className="step__body">
                <p className="step__kicker">공연이 끝나면</p>
                <p className="step__hero">
                  {advice.exitRush.from}~{advice.exitRush.to} 출차가 몰려요
                </p>
                <p className="step__text">
                  끝나자마자 나가면 정체를 피하기 어려워요. <Plate size="sm">{advice.exitRush.to}</Plate> 이후에 출발하거나 지하철을 이용하세요.
                </p>
                <p className="step__basis">
                  2024년 7월 KSPO DOME 공연 7회를 실측해 보니, 종료 후 출차의 80%가 빠지기까지 {day.model.exitMinutes}분(중앙값)이 걸렸어요.
                  {!show.runtimeKnown && ` 이 공연은 런타임 정보가 없어 종료 시각을 시작 ${show.runtimeMin}분 뒤로 잡았어요.`}
                </p>
              </div>
            </li>

            <Transit stations={stations} />
          </ol>
        </>
      ) : (
        <ParkAdvice day={day} stations={stations} />
      )}
    </Card>
  );
}

/** 대형 공연은 바로 보이고, 2,000석 미만 공연은 접어 둔다. */
function ShowPicker({ shows, selectedId, onShow }: { shows: Show[]; selectedId: string; onShow: (id: string) => void }) {
  const major = shows.filter((s) => s.major);
  const minor = shows.filter((s) => !s.major);
  const item = (s: Show) => (
    <label key={s.id} className={`showpick__item${s.id === selectedId ? ' is-checked' : ''}`}>
      <input type="radio" name="show" checked={s.id === selectedId} onChange={() => onShow(s.id)} />
      <span className="showpick__name">{s.name}</span>
      <span className="showpick__meta">
        {shortHall(s.hall)} · {s.start} · {num(s.seats)}석
      </span>
    </label>
  );
  return (
    <fieldset className="showpick">
      <legend className="sr-only">공연 선택</legend>
      {(major.length ? major : minor).map(item)}
      {major.length > 0 && minor.length > 0 && (
        <details className="showpick__more" open={minor.some((s) => s.id === selectedId)}>
          <summary>소규모 공연 {minor.length}개</summary>
          <div className="showpick__minor">{minor.map(item)}</div>
        </details>
      )}
    </fieldset>
  );
}

function Transit({ stations }: { stations: Station[] }) {
  const groups = stationGroups(stations);
  if (!groups.length) return null;
  return (
    <li className="step">
      <span className="step__icon">
        <Icon.train />
      </span>
      <div className="step__body">
        <p className="step__kicker">지하철</p>
        <ul className="stations">
          {groups.map((g) => (
            <li key={g.name}>
              <span className="stations__name">{g.name}</span>
              <span className="stations__lines">
                {g.lines.map((l) => (
                  <span key={l} className={`line line--${l}`} aria-label={`${l}호선`}>
                    {l}
                  </span>
                ))}
              </span>
              {g.note && <span className="stations__note">{g.note}</span>}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function ParkAdvice({ day, stations }: { day: DayData; stations: Station[] }) {
  const { best, avoid } = day.advice.park;
  const levelIn = (from: string, to: string): Level =>
    day.forecast.bins
      .filter((b) => toMinutes(b.t) >= toMinutes(from) && toMinutes(b.t) < toMinutes(to))
      .reduce<Level>((m, b) => (RANK[b.level] > RANK[m] ? b.level : m), 'calm');

  return (
    <ol className="steps">
      <li className="step">
        <span className="step__icon">
          <Icon.walk />
        </span>
        <div className="step__body">
          <p className="step__kicker">추천 시간</p>
          {best.length ? (
            <>
              <p className="step__hero step__hero--plates">
                {best.map((w) => (
                  <Plate key={w.from}>
                    {w.from}~{w.to}
                  </Plate>
                ))}
              </p>
              <p className="step__text">08~20시 중 주차 수요가 보통 이하로 예상되는 시간이에요.</p>
            </>
          ) : (
            <>
              <p className="step__hero">여유로운 시간이 거의 없어요</p>
              <p className="step__text">이날은 지하철로 오는 편이 편해요.</p>
            </>
          )}
        </div>
      </li>
      {avoid.length > 0 && (
        <li className="step">
          <span className="step__icon">
            <Icon.alert />
          </span>
          <div className="step__body">
            <p className="step__kicker">피할 시간</p>
            <ul className="avoid">
              {avoid.map((w) => (
                <li key={w.from}>
                  <span className="avoid__time">
                    {w.from}~{w.to}
                  </span>
                  <LevelTag level={levelIn(w.from, w.to)} />
                  <span className="avoid__why">{w.reason === 'event' ? '공연 영향' : '평소에도 붐비는 시간'}</span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      )}
      <Transit stations={stations} />
    </ol>
  );
}
