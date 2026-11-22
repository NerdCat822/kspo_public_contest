import { useMemo } from 'react';
import type { LiveResponse } from '../../shared/types.ts';
import { clock } from '../format.ts';
import { useWidth } from '../useWidth.ts';
import { Card, roadTone } from './ui.tsx';

const PARK = { lat: 37.5207, lng: 127.1215 };
const LABELED_ROADS = ['강동대로', '위례성대로', '올림픽로', '양재대로', '백제고분로'];
const ORDER: Record<string, number> = { good: 0, warning: 1, critical: 2 };

/**
 * 서울시 실시간 도시데이터의 도로 구간 좌표로 그린 소통 지도.
 * 배경 지도 없이 도로·주차장·역만 그린다(지도 API 키 불필요).
 */
export function RoadMap({ live }: { live: LiveResponse | null }) {
  const road = live?.road;
  const [boxRef, W] = useWidth<HTMLElement>(440);
  const geo = useMemo(() => {
    if (!road?.links.length) return null;
    const pts = road.links.flatMap((l) => l.path);
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const padX = (maxX - minX) * 0.05;
    const padY = (maxY - minY) * 0.06;
    minX -= padX;
    maxX += padX;
    minY -= padY;
    maxY += padY;
    const cos = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
    const scale = W / ((maxX - minX) * cos);
    const H = (maxY - minY) * scale;
    const project = (lng: number, lat: number): [number, number] => [(lng - minX) * cos * scale, (maxY - lat) * scale];
    const inside = (lng: number, lat: number) => lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
    return { H, project, inside };
  }, [road, W]);

  const labels = useMemo(() => {
    if (!road || !geo) return [];
    return LABELED_ROADS.flatMap((name) => {
      const segs = road.links.filter((l) => l.name === name && l.path.length >= 2);
      if (!segs.length) return [];
      const longest = segs.reduce((m, l) => (segLen(l.path) > segLen(m.path) ? l : m));
      const mid = longest.path[Math.floor(longest.path.length / 2)];
      const prev = longest.path[Math.max(0, Math.floor(longest.path.length / 2) - 1)];
      const [x1, y1] = geo.project(prev[0], prev[1]);
      const [x2, y2] = geo.project(mid[0], mid[1]);
      let angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const [x, y] = geo.project((mid[0] + prev[0]) / 2, (mid[1] + prev[1]) / 2);
      return [{ name, x, y, angle }];
    });
  }, [road, geo]);

  if (!road || !geo) {
    return (
      <Card className="roadmap" title="주변 도로 소통">
        <figure className="roadmap__figure" ref={boxRef}>
          <p className="muted">도로 소통 정보를 불러오는 중이에요.</p>
        </figure>
      </Card>
    );
  }

  const links = [...road.links].sort((a, b) => ORDER[roadTone(a.idx)] - ORDER[roadTone(b.idx)]);
  const counts = road.links.reduce<Record<string, number>>((m, l) => ({ ...m, [l.idx]: (m[l.idx] ?? 0) + 1 }), {});
  const [px, py] = geo.project(PARK.lng, PARK.lat);
  const controls = (live?.controls ?? []).filter((c) => c.lat != null && c.lng != null && geo.inside(c.lng, c.lat));

  return (
    <Card
      className="roadmap"
      id="roadmap"
      title="주변 도로 소통"
      aside={
        <span className="meta">
          평균 {road.speed}km/h · {clock(road.at)}
        </span>
      }
    >
      <figure className="roadmap__figure" ref={boxRef}>
        <svg viewBox={`0 0 ${W} ${geo.H}`} width={W} height={geo.H} role="img" aria-label={`올림픽공원 주변 도로 ${road.links.length}개 구간: 원활 ${counts['원활'] ?? 0}, 서행 ${counts['서행'] ?? 0}, 정체 ${counts['정체'] ?? 0}`}>
          <text className="roadmap__park" x={px} y={py} textAnchor="middle">
            올림픽공원
          </text>
          {links.map((l) => {
            const d = l.path.map(([x, y], i) => `${i ? 'L' : 'M'}${geo.project(x, y).join(',')}`).join('');
            return (
              <g key={l.id}>
                <path d={d} className="roadmap__casing" />
                <path d={d} className={`roadmap__road tone-${roadTone(l.idx)}`}>
                  <title>{`${l.name} ${l.from} → ${l.to}: ${l.idx} ${l.speed}km/h`}</title>
                </path>
              </g>
            );
          })}
          {labels.map((lb) => (
            <text key={lb.name} className="roadmap__label" x={lb.x} y={lb.y - 6} textAnchor="middle" transform={`rotate(${lb.angle} ${lb.x} ${lb.y - 6})`}>
              {lb.name}
            </text>
          ))}
          {(live?.lots ?? []).map((lot) => {
            const [x, y] = geo.project(lot.lng, lot.lat);
            return (
              <g key={lot.id} className="roadmap__lot" transform={`translate(${x} ${y})`}>
                <rect x={-7} y={-7} width={14} height={14} rx={3} />
                <text y={4} textAnchor="middle">
                  P
                </text>
                <title>{`${lot.name} ${lot.capacity}면`}</title>
              </g>
            );
          })}
          {(live?.stations ?? []).map((s) => {
            const [x, y] = geo.project(s.lng, s.lat);
            return (
              <g key={`${s.name}-${s.line}`} className="roadmap__station" transform={`translate(${x} ${y})`}>
                <circle r={4.5} />
                <title>{`${s.name} ${s.line}호선`}</title>
              </g>
            );
          })}
          {controls.map((c) => {
            const [x, y] = geo.project(c.lng!, c.lat!);
            return (
              <g key={c.id} className="roadmap__control" transform={`translate(${x} ${y})`}>
                <path d="M0,-8L7,5H-7Z" />
                <title>{`${c.kind}: ${c.info}`}</title>
              </g>
            );
          })}
        </svg>
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
        </figcaption>
      </figure>
    </Card>
  );
}

function segLen(path: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return s;
}
