import type { Control } from '../../shared/types.ts';
import { cached } from '../cache.ts';
import { env } from '../env.ts';
import { PARK_CENTER, fromTm, toTm } from '../geo.ts';
import { fetchText, xmlBlocks, xmlText } from '../http.ts';

/** 서울시 돌발 유형 코드(AccMainCode·AccSubCode API 기준) */
const MAIN: Record<string, string> = {
  A01: '교통사고',
  A02: '차량고장',
  A03: '보행사고',
  A04: '공사',
  A05: '낙하물',
  A06: '버스사고',
  A07: '지하철사고',
  A08: '화재',
  A09: '기상·재난',
  A10: '집회·행사',
  A11: '기타',
  A12: '제보',
  A13: '단순정보',
};
const SUB: Record<string, string> = { '10B02': '집회', '10B03': '행사', '04B01': '시설물보수', '04B04': '도로보수', '04B06': '포장공사' };

const RADIUS_M = 3000;
const center = toTm(PARK_CENTER.lat, PARK_CENTER.lng);

function stamp(date: string, time: string): string | null {
  if (!/^\d{8}$/.test(date)) return null;
  const t = time.padEnd(4, '0');
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

/** 서울시 실시간 돌발정보 중 올림픽공원 반경 3km 안의 사고·공사·통제 */
export function getNearbyControls(): Promise<Control[]> {
  return cached('seoul-accinfo', 5 * 60_000, async () => {
    if (!env.seoulKey) throw new Error('SEOUL_API_KEY 없음');
    const xml = await fetchText(`http://openapi.seoul.go.kr:8088/${encodeURIComponent(env.seoulKey)}/xml/AccInfo/1/300/`);
    const out: Control[] = [];
    for (const row of xmlBlocks(xml, 'row')) {
      const x = Number(xmlText(row, 'grs80tm_x'));
      const y = Number(xmlText(row, 'grs80tm_y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const distanceM = Math.round(Math.hypot(x - center.x, y - center.y));
      if (distanceM > RADIUS_M) continue;
      const { lat, lng } = fromTm(x, y);
      const sub = SUB[xmlText(row, 'acc_dtype')];
      out.push({
        id: xmlText(row, 'acc_id'),
        kind: sub ?? MAIN[xmlText(row, 'acc_type')] ?? '돌발',
        info: xmlText(row, 'acc_info').replace(/\s*\r?\n\s*/g, ' ').trim(),
        from: stamp(xmlText(row, 'occr_date'), xmlText(row, 'occr_time')),
        to: stamp(xmlText(row, 'exp_clr_date'), xmlText(row, 'exp_clr_time')),
        distanceM,
        lat,
        lng,
      });
    }
    return out.sort((p, q) => (p.distanceM ?? 0) - (q.distanceM ?? 0));
  });
}
