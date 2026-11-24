import { useEffect, useRef } from 'react';
import type { OverviewDay } from '../../shared/types.ts';
import { LEVEL_LABEL } from '../../shared/types.ts';
import { monthDay } from '../format.ts';
import { levelTone } from './ui.tsx';

interface Props {
  days: OverviewDay[] | null;
  selected: string | null;
  today: string | null;
  onSelect: (date: string) => void;
}

/**
 * 앞으로 2주. 평일 오전처럼 매일 반복되는 혼잡은 '평소 수준'으로 묶고,
 * 대형 공연이 있는 날만 예상 단계를 색으로 드러낸다.
 */
export function DateStrip({ days, selected, today, onSelect }: Props) {
  const strip = useRef<HTMLElement>(null);
  const selectedBtn = useRef<HTMLButtonElement>(null);
  const settled = useRef(false);

  // 좁은 화면에서는 띠가 가로로 넘친다. 고른 날짜가 화면 밖이면 가운데로 옮긴다.
  // scrollIntoView 는 페이지까지 세로로 움직일 수 있어서 띠의 가로 위치만 직접 바꾼다.
  useEffect(() => {
    const box = strip.current;
    const btn = selectedBtn.current;
    if (!box || !btn) return;
    const boxRect = box.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const left = btnRect.left - boxRect.left - (box.clientWidth - btnRect.width) / 2;
    const smooth = settled.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollBy({ left, behavior: smooth ? 'smooth' : 'auto' }); // 처음 열 때는 움직임 없이 바로
    settled.current = true;
  }, [selected, days]);

  if (!days) {
    return <div className="datestrip datestrip--loading" aria-hidden="true" />;
  }
  return (
    <nav className="datestrip" aria-label="날짜 선택" ref={strip}>
      <ol className="datestrip__list">
        {days.map((d) => {
          const { m, d: day } = monthDay(d.date);
          const isSel = d.date === selected;
          const show = d.majorShows[0];
          const eventDay = d.majorShows.length > 0;
          const tone = eventDay ? levelTone[d.peakLevel] : 'quiet';
          return (
            <li key={d.date}>
              <button
                type="button"
                ref={isSel ? selectedBtn : undefined}
                className={`daybtn${isSel ? ' is-selected' : ''}`}
                aria-pressed={isSel}
                aria-label={`${m}월 ${day}일 ${d.weekday}요일, ${eventDay ? `${shortHall(show.hall)} ${show.start} 공연, ${LEVEL_LABEL[d.peakLevel]}` : '평소 수준'}`}
                title={show ? `${shortHall(show.hall)} ${show.start} · ${show.name}` : undefined}
                onClick={() => onSelect(d.date)}
              >
                <span className="daybtn__top">
                  <span className="daybtn__wd">{d.date === today ? '오늘' : d.weekday}</span>
                  <span className="daybtn__date">
                    {d.date.endsWith('-01') ? `${m}.` : ''}
                    {day}
                  </span>
                </span>
                <span className={`daybtn__bar tone-${tone}`} aria-hidden="true" />
                <span className={`daybtn__level${eventDay ? '' : ' is-quiet'}`}>{eventDay ? LEVEL_LABEL[d.peakLevel] : '평소 수준'}</span>
                <span className="daybtn__event">{show ? `${show.start} 공연` : d.holidayName ?? ''}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function shortHall(hall: string): string {
  return hall
    .replace(/\(체조경기장\)/, '')
    .replace(/티켓링크 라이브 아레나\s*\(핸드볼경기장\)/, '핸드볼경기장')
    .replace(/^야외\((.*)\)$/, '$1')
    .replace(/\(.*\)$/, '')
    .trim();
}
