import { useEffect, useRef, useState } from 'react';
import type { LiveResponse } from '../../shared/types.ts';
import { clock } from '../format.ts';
import { loadNaverMaps, onAuthFailure } from '../naverMaps.ts';
import { RoadMap } from './RoadMap.tsx';
import { Card, roadTone } from './ui.tsx';

const PARK = { lat: 37.5195, lng: 127.1215 };
const ORDER: Record<string, number> = { good: 0, warning: 1, critical: 2 };

type Overlay = { setMap(map: naver.maps.Map | null): void };

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 네이버 지도 위에 서울시 실시간 도시데이터의 도로 구간을 소통 상태 색으로 그린다.
 * Client ID 가 없거나 인증·로딩에 실패하면 배경 지도 없는 간이 지도(RoadMap)로 대신 보여 준다.
 */
export function NaverRoadMap({ live, clientId }: { live: LiveResponse | null; clientId: string | null | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<naver.maps.Map | null>(null);
  const overlays = useRef<Overlay[]>([]);
  const fitted = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (clientId === undefined) return; // 설정을 아직 받지 않았다
    if (!clientId) {
      setState('failed');
      setNote('네이버 지도 Client ID 가 없어 간이 지도로 보여 드려요');
      return;
    }
    let cancelled = false;
    const fail = (message: string) => {
      if (cancelled) return;
      setState('failed');
      setNote(message);
    };
    const off = onAuthFailure(() => fail(`네이버 지도 인증에 실패해 간이 지도로 보여 드려요(${window.location.origin} 미등록)`));
    loadNaverMaps(clientId)
      .then((maps) => {
        if (cancelled || !box.current) return;
        mapRef.current = new maps.Map(box.current, {
          center: new maps.LatLng(PARK.lat, PARK.lng),
          zoom: 15,
          minZoom: 12,
          scaleControl: false,
          mapDataControl: false,
          scrollWheel: false, // 페이지 스크롤을 지도가 가로채지 않게
          logoControlOptions: { position: maps.Position.BOTTOM_LEFT },
          zoomControl: true,
          zoomControlOptions: { position: maps.Position.TOP_RIGHT, style: maps.ZoomControlStyle.SMALL },
        });
        setState('ready');
      })
      .catch((e: Error) => fail(`${e.message} 간이 지도로 보여 드려요`));
    return () => {
      cancelled = true;
      off();
      overlays.current.forEach((o) => o.setMap(null));
      overlays.current = [];
      mapRef.current?.destroy();
      mapRef.current = null;
      fitted.current = false;
    };
  }, [clientId]);

  useEffect(() => {
    const map = mapRef.current;
    const road = live?.road;
    if (state !== 'ready' || !map || !road) return;
    const maps = naver.maps;
    overlays.current.forEach((o) => o.setMap(null));
    overlays.current = [];

    const color = { good: cssVar('--status-good'), warning: cssVar('--status-warning'), critical: cssVar('--status-critical') };
    const links = [...road.links].sort((a, b) => ORDER[roadTone(a.idx)] - ORDER[roadTone(b.idx)]);
    const bounds = new maps.LatLngBounds(new maps.LatLng(PARK.lat, PARK.lng), new maps.LatLng(PARK.lat, PARK.lng));
    for (const l of links) {
      const path = l.path.map(([lng, lat]) => new maps.LatLng(lat, lng));
      path.forEach((p) => bounds.extend(p));
      const tone = roadTone(l.idx) as keyof typeof color;
      overlays.current.push(
        new maps.Polyline({ map, path, strokeColor: '#ffffff', strokeWeight: 8, strokeOpacity: 0.9, strokeLineCap: 'round', strokeLineJoin: 'round', zIndex: 1 }),
        new maps.Polyline({ map, path, strokeColor: color[tone], strokeWeight: 5, strokeOpacity: 0.95, strokeLineCap: 'round', strokeLineJoin: 'round', zIndex: 2 }),
      );
    }
    for (const lot of live?.lots ?? []) {
      overlays.current.push(
        new maps.Marker({
          map,
          position: new maps.LatLng(lot.lat, lot.lng),
          title: `${lot.name} ${lot.capacity.toLocaleString('ko-KR')}면`,
          icon: { content: '<span class="nmap-lot" aria-hidden="true">P</span>', anchor: new maps.Point(9, 9) },
          zIndex: 10,
        }),
      );
    }
    for (const s of live?.stations ?? []) {
      overlays.current.push(
        new maps.Marker({
          map,
          position: new maps.LatLng(s.lat, s.lng),
          title: `${s.name} ${s.line}호선`,
          icon: { content: '<span class="nmap-station" aria-hidden="true"></span>', anchor: new maps.Point(6, 6) },
          zIndex: 9,
        }),
      );
    }
    for (const c of live?.controls ?? []) {
      if (c.lat == null || c.lng == null) continue;
      overlays.current.push(
        new maps.Marker({
          map,
          position: new maps.LatLng(c.lat, c.lng),
          title: `${c.kind}: ${c.info}`,
          icon: { content: '<span class="nmap-control" aria-hidden="true"></span>', anchor: new maps.Point(8, 12) },
          zIndex: 11,
        }),
      );
    }
    if (!fitted.current) {
      map.fitBounds(bounds, { top: 24, right: 24, bottom: 24, left: 24 });
      fitted.current = true;
    }
  }, [state, live]);

  if (state === 'failed') return <RoadMap live={live} note={note} />;

  const road = live?.road;
  const counts = (road?.links ?? []).reduce<Record<string, number>>((m, l) => ({ ...m, [l.idx]: (m[l.idx] ?? 0) + 1 }), {});
  return (
    <Card
      className="roadmap"
      id="roadmap"
      title="주변 도로 소통"
      aside={road ? <span className="meta">평균 {road.speed}km/h · {clock(road.at)}</span> : null}
    >
      <figure className="roadmap__figure">
        <div
          ref={box}
          className="nmap"
          role="img"
          aria-label={road ? `올림픽공원 주변 도로 ${road.links.length}개 구간: 원활 ${counts['원활'] ?? 0}, 서행 ${counts['서행'] ?? 0}, 정체 ${counts['정체'] ?? 0}` : '지도를 불러오는 중'}
        />
        <figcaption>
          <ul className="legend legend--map">
            <li>
              <span className="legend__line tone-good" />
              원활
            </li>
            <li>
              <span className="legend__line tone-warning" />
              서행
            </li>
            <li>
              <span className="legend__line tone-critical" />
              정체
            </li>
            <li>
              <span className="legend__lot">P</span>
              공영주차장
            </li>
            <li>
              <span className="legend__station" />
              지하철역
            </li>
          </ul>
          <p className="caption">도로 소통은 서울시 실시간 도시데이터, 배경 지도는 네이버 지도예요</p>
        </figcaption>
      </figure>
    </Card>
  );
}
