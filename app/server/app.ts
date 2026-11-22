import { Hono } from 'hono';
import type { DayResponse, DayType, LiveResponse, OverviewDay, Show } from '../shared/types.ts';
import { readDay } from './collector.ts';
import { env } from './env.ts';
import { MODEL_META, THRESHOLDS, concertAdvice, forecastDay, parkAdvice } from './model/forecast.ts';
import { getHolidays } from './sources/holidays.ts';
import { getDayWeather } from './sources/kma.ts';
import { getShowsByDate } from './sources/kopis.ts';
import { getParkingSum } from './sources/kspoParking.ts';
import { getNearbyControls } from './sources/seoulAcc.ts';
import { getCityData } from './sources/seoulCity.ts';
import { WEEKDAYS, addDays, kstStamp, parseYmd, todayKst, weekdayOf } from './time.ts';

export const api = new Hono();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function dayTypeOf(date: string, holidays: Record<string, string>): DayType {
  if (holidays[date]) return 'holiday';
  const w = weekdayOf(date);
  return w === 0 || w === 6 ? 'weekend' : 'weekday';
}

/** 공연 일정은 기간 단위로 한 번에 받아 캐시한다. 실패하면 공연 없이 기준선만으로 예측한다. */
async function showsAndHolidays(from: string, to: string) {
  const holidays = await getHolidays(from, to);
  let shows = new Map<string, Show[]>();
  let showsError: string | null = null;
  try {
    shows = await getShowsByDate(from, to, new Set(Object.keys(holidays)));
  } catch (e) {
    showsError = message(e);
  }
  return { holidays, shows, showsError };
}

api.get('/api/health', (c) =>
  c.json({
    ok: true,
    at: kstStamp(),
    keys: { kopis: !!env.kopisKey, seoul: !!env.seoulKey, dataGoKr: !!env.dataGoKrKey, culture: !!env.cultureKey },
  }),
);

api.get('/api/overview', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 14), 1), 31);
  const from = todayKst();
  const to = addDays(from, days - 1);
  const { holidays, shows, showsError } = await showsAndHolidays(from, to);
  const out: OverviewDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const list = shows.get(d) ?? [];
    const dayType = dayTypeOf(d, holidays);
    const f = forecastDay(dayType, list);
    out.push({
      date: d,
      weekday: WEEKDAYS[weekdayOf(d)],
      dayType,
      holidayName: holidays[d] ?? null,
      peakLevel: f.peak.level,
      peakTime: f.peak.t,
      majorShows: list.filter((s) => s.major).map((s) => ({ name: s.name, hall: s.hall, start: s.start, seats: s.seats })),
    });
  }
  return c.json({ days: out, errors: showsError ? { shows: showsError } : {} });
});

api.get('/api/day', async (c) => {
  const date = c.req.query('date') ?? todayKst();
  if (!parseYmd(date)) return c.json({ error: 'date 는 YYYY-MM-DD 형식이어야 합니다.' }, 400);
  const { holidays, shows, showsError } = await showsAndHolidays(date, date);
  const list = shows.get(date) ?? [];
  const dayType = dayTypeOf(date, holidays);
  const f = forecastDay(dayType, list);
  let weather = null;
  try {
    weather = await getDayWeather(date);
  } catch {
    weather = null;
  }
  const body: DayResponse & { errors: Record<string, string> } = {
    date,
    weekday: WEEKDAYS[weekdayOf(date)],
    dayType,
    holidayName: holidays[date] ?? null,
    shows: list,
    forecast: { bins: f.bins, peak: f.peak, thresholds: THRESHOLDS },
    advice: { concert: list.map((s) => concertAdvice(s, f.bins)), park: parkAdvice(f.bins) },
    weather,
    model: MODEL_META,
    errors: showsError ? { shows: showsError } : {},
  };
  return c.json(body);
});

api.get('/api/live', async (c) => {
  const errors: Record<string, string> = {};
  const [parking, city, controls] = await Promise.allSettled([getParkingSum(), getCityData(), getNearbyControls()]);
  if (parking.status === 'rejected') errors.parking = message(parking.reason);
  if (city.status === 'rejected') errors.city = message(city.reason);
  if (controls.status === 'rejected') errors.controls = message(controls.reason);
  const cityData = city.status === 'fulfilled' ? city.value : null;

  const today = readDay(todayKst())
    .filter((r) => r.parking != null)
    .map((r) => ({ at: r.at, sum: r.parking as number }));

  const nearby = controls.status === 'fulfilled' ? controls.value : [];
  const body: LiveResponse = {
    fetchedAt: kstStamp(),
    parking: parking.status === 'fulfilled' ? { ...parking.value, today } : null,
    population: cityData?.population ?? null,
    road: cityData?.road ?? null,
    weather: cityData?.weather ?? null,
    lots: cityData?.lots ?? [],
    stations: cityData?.stations ?? [],
    controls: [...(cityData?.controls ?? []), ...nearby.filter((n) => !(cityData?.controls ?? []).some((x) => x.info === n.info))],
    errors,
  };
  return c.json(body);
});
