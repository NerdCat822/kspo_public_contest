import type { Show } from '../../shared/types.ts';
import { cached } from '../cache.ts';
import { env } from '../env.ts';
import { fetchText, xmlBlocks, xmlText } from '../http.ts';
import { addDays, hhmm, parseYmd, toMinutes, weekdayOf } from '../time.ts';

const BASE = 'http://www.kopis.or.kr/openApi/restful';
/** KOPIS 공연시설 ID: 올림픽공원 */
const FACILITY = 'FC001247';
/** 예측에 반영하는 공연장 최소 좌석 수 */
export const MAJOR_MIN_SEATS = 2000;
/** 런타임이 비어 있을 때 쓰는 기본값(분). 2024년 7월 대형 공연 평균에 가깝게 잡았다. */
const DEFAULT_RUNTIME = 150;

interface Hall {
  name: string;
  seats: number;
}

interface PerfDetail {
  id: string;
  name: string;
  genre: string;
  from: string;
  to: string;
  facility: string;
  schedule: string;
  runtime: string;
}

const key = () => {
  if (!env.kopisKey) throw new Error('KOPIS_API_KEY 없음');
  return encodeURIComponent(env.kopisKey);
};

function getHalls(): Promise<Hall[]> {
  return cached(
    'kopis-halls',
    7 * 24 * 3600_000,
    async () => {
      const xml = await fetchText(`${BASE}/prfplc/${FACILITY}?service=${key()}`);
      return xmlBlocks(xml, 'mt13').map((b) => ({
        name: xmlText(b, 'prfplcnm'),
        seats: Number(xmlText(b, 'seatscale').replace(/,/g, '')) || 0,
      }));
    },
    true,
  );
}

function listIds(from: string, to: string): Promise<string[]> {
  return cached(
    `kopis-list-${from}-${to}`,
    6 * 3600_000,
    async () => {
      const ids: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const xml = await fetchText(
          `${BASE}/pblprfr?service=${key()}&stdate=${from.replace(/-/g, '')}&eddate=${to.replace(/-/g, '')}` +
            `&cpage=${page}&rows=100&signgucode=11&signgucodesub=1171`,
        );
        const rows = xmlBlocks(xml, 'db');
        for (const r of rows) if (xmlText(r, 'fcltynm').includes('올림픽공원')) ids.push(xmlText(r, 'mt20id'));
        if (rows.length < 100) break;
      }
      return ids;
    },
    true,
  );
}

function getDetail(id: string): Promise<PerfDetail> {
  return cached(
    `kopis-detail-${id}`,
    12 * 3600_000,
    async () => {
      const b = xmlBlocks(await fetchText(`${BASE}/pblprfr/${id}?service=${key()}`), 'db')[0] ?? '';
      return {
        id,
        name: xmlText(b, 'prfnm'),
        genre: xmlText(b, 'genrenm'),
        from: xmlText(b, 'prfpdfrom').replace(/\./g, '-'),
        to: xmlText(b, 'prfpdto').replace(/\./g, '-'),
        facility: xmlText(b, 'fcltynm'),
        schedule: xmlText(b, 'dtguidance'),
        runtime: xmlText(b, 'prfruntime'),
      };
    },
    true,
  );
}

const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

/** '화요일 ~ 금요일(11:00,14:00), 토요일(18:00), HOL(14:00)' → 요일(0=월)·HOL 별 시작 시각 */
export function parseSchedule(text: string): Map<number | 'HOL', string[]> {
  const out = new Map<number | 'HOL', string[]>();
  const re = /([^(),]+)\(([^)]*)\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const spec = m[1].trim();
    const times = m[2]
      .split(',')
      .map((t) => t.trim())
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
      .map((t) => t.padStart(5, '0'));
    if (spec.toUpperCase() === 'HOL') {
      out.set('HOL', [...(out.get('HOL') ?? []), ...times]);
      continue;
    }
    const names = spec.split('~').map((s) => s.trim()[0]);
    if (!names.every((n) => DAYS.includes(n))) continue;
    const a = DAYS.indexOf(names[0]);
    const b = DAYS.indexOf(names[names.length - 1]);
    for (let i = 0; i < 7; i++) {
      const d = (a + i) % 7;
      out.set(d, [...(out.get(d) ?? []), ...times]);
      if (d === b) break;
    }
  }
  return out;
}

export function parseRuntime(text: string): number | null {
  const h = text.match(/(\d+)\s*시간/);
  const m = text.match(/(\d+)\s*분/);
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return total || null;
}

function hallOf(facility: string, halls: Hall[]): Hall | null {
  const inner = facility.match(/^[^(]*\((.*)\)\s*$/)?.[1]?.trim() ?? '';
  return halls.find((h) => h.name === inner) ?? halls.find((h) => inner && (inner.includes(h.name) || h.name.includes(inner))) ?? null;
}

/**
 * 기간 안 날짜별 올림픽공원 공연 회차.
 * holidays 에 든 날짜는 KOPIS 의 HOL 일정이 있으면 그것을 쓴다.
 */
export async function getShowsByDate(from: string, to: string, holidays: Set<string>): Promise<Map<string, Show[]>> {
  const [halls, ids] = await Promise.all([getHalls(), listIds(from, to)]);
  const details: PerfDetail[] = [];
  for (const id of ids) details.push(await getDetail(id)); // KOPIS 부하를 줄이려 순차 호출(캐시됨)

  const byDate = new Map<string, Show[]>();
  for (let d = from; d <= to; d = addDays(d, 1)) byDate.set(d, []);

  for (const p of details) {
    const hall = hallOf(p.facility, halls);
    const schedule = parseSchedule(p.schedule);
    const runtime = parseRuntime(p.runtime);
    for (const [date, list] of byDate) {
      if (date < p.from || date > p.to || !parseYmd(date)) continue;
      const dow = (weekdayOf(date) + 6) % 7; // 0=월
      const times = (holidays.has(date) && schedule.get('HOL')) || schedule.get(dow) || [];
      for (const start of times) {
        const runtimeMin = runtime ?? DEFAULT_RUNTIME;
        list.push({
          id: `${p.id}-${date}-${start}`,
          name: p.name,
          hall: hall?.name ?? p.facility.replace(/^올림픽공원\s*/, '').replace(/^\(|\)$/g, ''),
          seats: hall?.seats ?? 0,
          start,
          end: hhmm(toMinutes(start) + runtimeMin),
          runtimeMin,
          runtimeKnown: runtime != null,
          genre: p.genre,
          major: (hall?.seats ?? 0) >= MAJOR_MIN_SEATS,
        });
      }
    }
  }
  for (const list of byDate.values()) list.sort((a, b) => b.seats - a.seats || a.start.localeCompare(b.start));
  return byDate;
}
