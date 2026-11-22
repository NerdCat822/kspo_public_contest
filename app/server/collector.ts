import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from './env.ts';
import { getParkingSum } from './sources/kspoParking.ts';
import { getCityData } from './sources/seoulCity.ts';
import { kstStamp, todayKst } from './time.ts';

/**
 * 실시간 값을 5분마다 data/runtime/live-YYYY-MM-DD.jsonl 에 쌓는다.
 * 기관 API는 이력을 주지 않아서, 예측과 실측을 비교하려면 직접 모아야 한다.
 */
const INTERVAL_MS = 5 * 60_000;
const dir = () => path.join(env.dataDir, 'runtime');
const fileOf = (date: string) => path.join(dir(), `live-${date}.jsonl`);

export interface LiveRecord {
  at: string;
  parking: number | null;
  popLevel: string | null;
  popMin: number | null;
  popMax: number | null;
  roadLevel: string | null;
  roadSpeed: number | null;
}

export async function collectOnce(): Promise<LiveRecord> {
  const [parking, city] = await Promise.allSettled([getParkingSum(), getCityData()]);
  const p = parking.status === 'fulfilled' ? parking.value : null;
  const c = city.status === 'fulfilled' ? city.value : null;
  const rec: LiveRecord = {
    at: kstStamp(),
    parking: p?.sum ?? null,
    popLevel: c?.population?.level ?? null,
    popMin: c?.population?.min ?? null,
    popMax: c?.population?.max ?? null,
    roadLevel: c?.road?.level ?? null,
    roadSpeed: c?.road?.speed ?? null,
  };
  mkdirSync(dir(), { recursive: true });
  appendFileSync(fileOf(todayKst()), `${JSON.stringify(rec)}\n`);
  return rec;
}

export function readDay(date: string): LiveRecord[] {
  const file = fileOf(date);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LiveRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is LiveRecord => r != null);
}

let timer: NodeJS.Timeout | null = null;

export function startCollector(log = (msg: string) => console.log(msg)): void {
  if (timer || process.env.GILMAK_COLLECT === '0') return;
  const run = () =>
    collectOnce()
      .then((r) => log(`[collector] ${r.at} 주차 ${r.parking ?? '-'}대 · 인구 ${r.popLevel ?? '-'} · 도로 ${r.roadLevel ?? '-'}`))
      .catch((e: unknown) => log(`[collector] 실패: ${e instanceof Error ? e.message : String(e)}`));
  void run();
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
}
