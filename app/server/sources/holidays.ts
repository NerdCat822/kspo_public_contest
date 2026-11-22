import { cached } from '../cache.ts';
import { env, queryKey } from '../env.ts';
import { fetchJson } from '../http.ts';

interface Item {
  locdate: number;
  dateName: string;
  isHoliday: string;
}

/** 한국천문연구원 특일정보: 해당 연·월의 공휴일 { 'YYYY-MM-DD': 이름 } */
function getMonth(year: number, month: number): Promise<Record<string, string>> {
  const mm = String(month).padStart(2, '0');
  return cached(
    `holidays-${year}-${mm}`,
    24 * 3600_000,
    async () => {
      const res = await fetchJson<{ response?: { body?: { items?: { item?: Item | Item[] } | '' } } }>(
        `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo` +
          `?serviceKey=${queryKey(env.dataGoKrKey)}&solYear=${year}&solMonth=${mm}&numOfRows=50&_type=json`,
      );
      const items = res.response?.body?.items;
      const list = !items ? [] : Array.isArray(items.item) ? items.item : items.item ? [items.item] : [];
      const out: Record<string, string> = {};
      for (const it of list) {
        if (it.isHoliday !== 'Y') continue;
        const s = String(it.locdate);
        out[`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`] = it.dateName;
      }
      return out;
    },
    true,
  );
}

/** 기간 안 공휴일. 실패하면 빈 값으로 둔다(요일만으로 판단). */
export async function getHolidays(from: string, to: string): Promise<Record<string, string>> {
  if (!env.dataGoKrKey) return {};
  const months = new Set<string>();
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.add(d.toISOString().slice(0, 7));
  }
  const out: Record<string, string> = {};
  await Promise.all(
    [...months].map(async (ym) => {
      try {
        Object.assign(out, await getMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))));
      } catch {
        // 특일정보를 못 받으면 주말 여부만으로 판단한다.
      }
    }),
  );
  return out;
}
