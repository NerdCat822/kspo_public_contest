import type { DayWeather } from '../../shared/types.ts';
import { cached } from '../cache.ts';
import { env, queryKey } from '../env.ts';
import { fetchJson } from '../http.ts';
import { kstNow, ymd } from '../time.ts';

/** 올림픽공원 기상청 격자 */
const NX = 62;
const NY = 126;
const BASE_TIMES = [2, 5, 8, 11, 14, 17, 20, 23];

interface Item {
  category: string;
  fcstDate: string;
  fcstTime: string;
  fcstValue: string;
}

/** 가장 최근 단기예보 발표 시각(발표 10분 뒤부터 조회 가능) */
function latestBase(): { date: string; time: string } {
  const now = kstNow();
  now.setUTCMinutes(now.getUTCMinutes() - 10);
  const hour = now.getUTCHours();
  const base = [...BASE_TIMES].reverse().find((h) => h <= hour);
  if (base === undefined) {
    now.setUTCDate(now.getUTCDate() - 1);
    return { date: ymd(now).replace(/-/g, ''), time: '2300' };
  }
  return { date: ymd(now).replace(/-/g, ''), time: `${String(base).padStart(2, '0')}00` };
}

function getForecastItems(): Promise<Item[]> {
  const base = latestBase();
  return cached(`kma-vilage-${base.date}-${base.time}`, 3 * 3600_000, async () => {
    const res = await fetchJson<{ response?: { header?: { resultCode: string; resultMsg: string }; body?: { items?: { item?: Item[] } } } }>(
      `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${queryKey(env.dataGoKrKey)}` +
        `&pageNo=1&numOfRows=1200&dataType=JSON&base_date=${base.date}&base_time=${base.time}&nx=${NX}&ny=${NY}`,
      20000,
    );
    const header = res.response?.header;
    if (header && header.resultCode !== '00') throw new Error(`기상청 ${header.resultCode} ${header.resultMsg}`);
    return res.response?.body?.items?.item ?? [];
  });
}

const SKY: Record<string, string> = { '1': '맑음', '3': '구름많음', '4': '흐림' };
const PTY: Record<string, string> = { '1': '비', '2': '비/눈', '3': '눈', '4': '소나기' };

/** 기상청 단기예보로 그날 날씨를 요약한다(오늘~3일 뒤). 범위 밖이면 null */
export async function getDayWeather(date: string): Promise<DayWeather | null> {
  if (!env.dataGoKrKey) return null;
  const day = date.replace(/-/g, '');
  const items = (await getForecastItems()).filter((i) => i.fcstDate === day);
  if (!items.length) return null;

  const values = (cat: string) => items.filter((i) => i.category === cat);
  const temps = values('TMP').map((i) => Number(i.fcstValue));
  if (temps.length < 12) return null; // 예보 범위 끝자락이라 하루치가 다 없으면 요약하지 않는다
  const tmn = values('TMN')[0];
  const tmx = values('TMX')[0];
  const pops = values('POP').map((i) => Number(i.fcstValue));
  const pty = values('PTY').map((i) => i.fcstValue).find((v) => v !== '0');

  // 낮 시간(09~21시) 하늘 상태 중 가장 흔한 값
  const skies = values('SKY')
    .filter((i) => Number(i.fcstTime) >= 900 && Number(i.fcstTime) <= 2100)
    .map((i) => i.fcstValue);
  const sky = skies.sort((p, q) => skies.filter((v) => v === q).length - skies.filter((v) => v === p).length)[0];

  return {
    sky: sky ? SKY[sky] ?? null : null,
    minTemp: tmn ? Number(tmn.fcstValue) : temps.length ? Math.min(...temps) : null,
    maxTemp: tmx ? Number(tmx.fcstValue) : temps.length ? Math.max(...temps) : null,
    rainChance: pops.length ? Math.max(...pops) : null,
    precipType: pty ? PTY[pty] ?? null : null,
    source: 'kma',
  };
}
