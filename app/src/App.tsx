import { useEffect, useState } from 'react';
import type { ConfigResponse, LiveResponse, OverviewDay } from '../shared/types.ts';
import { type DayData, api } from './api.ts';
import { AskDoctor } from './components/AskDoctor.tsx';
import { DateStrip } from './components/DateStrip.tsx';
import { Diagnosis } from './components/Diagnosis.tsx';
import { Controls, LiveNow, Lots } from './components/LiveNow.tsx';
import { type Purpose, Prescription } from './components/Prescription.tsx';
import { NaverRoadMap } from './components/NaverRoadMap.tsx';
import { clock } from './format.ts';

const LIVE_REFRESH_MS = 60_000;

/** ?date=YYYY-MM-DD 로 특정 날짜를 바로 열 수 있다(공유용). */
function dateFromUrl(): string | null {
  const d = new URLSearchParams(window.location.search).get('date');
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export default function App() {
  const [days, setDays] = useState<OverviewDay[] | null>(null);
  const [date, setDate] = useState<string | null>(dateFromUrl);
  const [day, setDay] = useState<DayData | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [purpose, setPurpose] = useState<Purpose>('concert');
  const [showId, setShowId] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);

  const today = days?.[0]?.date ?? null;

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig({ naverMapClientId: null }));
  }, []);

  useEffect(() => {
    api
      .overview()
      .then((r) => {
        setDays(r.days);
        setDate((d) => d ?? r.days[0]?.date ?? null);
      })
      .catch((e: Error) => setFatal(e.message));
  }, []);

  useEffect(() => {
    if (!date || !today) return;
    const query = date === today ? window.location.pathname : `?date=${date}`;
    window.history.replaceState(null, '', query);
  }, [date, today]);

  useEffect(() => {
    if (!date) return;
    let alive = true;
    setDayLoading(true);
    api
      .day(date)
      .then((d) => {
        if (!alive) return;
        setDay(d);
        setShowId(d.shows[0]?.id ?? null);
        setPurpose(d.shows.length ? 'concert' : 'park');
      })
      .catch((e: Error) => alive && setFatal(e.message))
      .finally(() => alive && setDayLoading(false));
    return () => {
      alive = false;
    };
  }, [date]);

  useEffect(() => {
    let timer: number | undefined;
    const load = () =>
      api
        .live()
        .then(setLive)
        .catch(() => undefined)
        .finally(() => {
          timer = window.setTimeout(load, LIVE_REFRESH_MS);
        });
    load();
    return () => window.clearTimeout(timer);
  }, []);

  const liveOk = live && !live.errors.parking && !live.errors.city;

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead__inner">
          <a className="brand" href="./" aria-label="길막닥터 처음으로">
            <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" />
              <path d="M13.5 7h5v6.5H25v5h-6.5V25h-5v-6.5H7v-5h6.5z" />
            </svg>
            <span className="brand__name">길막닥터</span>
          </a>
          <p className="masthead__tagline">올림픽공원 주차 혼잡 예보</p>
          {live && (
            <p className={`masthead__live${liveOk ? '' : ' is-degraded'}`}>
              <span className="masthead__dot" aria-hidden="true" />
              실시간 {clock(live.fetchedAt)}
            </p>
          )}
        </div>
      </header>

      <main className="main">
        {fatal && (
          <p className="notice notice--block" role="alert">
            데이터를 불러오지 못했어요({fatal}). 잠시 후 다시 시도해 주세요.
          </p>
        )}

        <DateStrip days={days} selected={date} today={today} onSelect={setDate} />

        <div className="layout">
          <div className="layout__main">
            <Diagnosis day={day} loading={dayLoading} isToday={!!day && day.date === today} />
            <Prescription
              day={day}
              stations={live?.stations ?? []}
              purpose={purpose}
              onPurpose={setPurpose}
              showId={showId}
              onShow={setShowId}
            />
          </div>
          <div className="layout__side">
            <AskDoctor day={day} date={date} />
            <aside className="layout__live" aria-label="실시간 현황">
              <LiveNow live={live} />
              <NaverRoadMap live={live} clientId={config ? config.naverMapClientId : undefined} />
              <Controls live={live} />
              <Lots live={live} />
            </aside>
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <p className="footer__title">데이터 출처</p>
          <ul className="footer__sources">
            <li>한국체육산업개발 · 실시간 주차현황, 올림픽공원 입출차 정보</li>
            <li>예술경영지원센터 KOPIS · 공연 일정, 공연장 좌석</li>
            <li>서울특별시 · 실시간 도시데이터, 실시간 돌발정보</li>
            <li>출처: 기상청 · 단기예보</li>
            <li>한국천문연구원 · 특일정보</li>
            <li>네이버 클라우드 플랫폼 · 배경 지도</li>
          </ul>
          {/* 어떤 데이터로 만든 모델인지는 모델 파일의 설명(meta.note)을 그대로 쓴다 */}
          <p className="footer__note">{day ? day.model.note : '예측 모델 정보를 불러오는 중이에요.'}</p>
          <p className="footer__note">2026 한국체육산업개발 공공데이터 활용 경진대회 출품작</p>
        </div>
      </footer>
    </div>
  );
}
