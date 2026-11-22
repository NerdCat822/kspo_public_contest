import type { Control, LiveResponse, ParkingLot, RoadLink, Station } from '../../shared/types.ts';
import { cached } from '../cache.ts';
import { env } from '../env.ts';
import { fetchJson } from '../http.ts';

/** 서울시 실시간 도시데이터: 올림픽공원 장소코드 */
const AREA = 'POI127';

type Raw = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface CityData {
  population: LiveResponse['population'];
  road: LiveResponse['road'];
  weather: LiveResponse['weather'];
  lots: ParkingLot[];
  stations: Station[];
  controls: Control[];
}

export function getCityData(): Promise<CityData> {
  return cached('seoul-citydata', 5 * 60_000, async () => {
    if (!env.seoulKey) throw new Error('SEOUL_API_KEY 없음');
    const res = await fetchJson<{ CITYDATA?: Raw; RESULT?: Raw }>(
      `http://openapi.seoul.go.kr:8088/${encodeURIComponent(env.seoulKey)}/json/citydata/1/5/${AREA}`,
      25000,
    );
    const c = res.CITYDATA;
    if (!c) throw new Error(`도시데이터 응답 없음: ${str(res.RESULT?.['RESULT.MESSAGE'])}`);
    return normalize(c);
  });
}

function normalize(c: Raw): CityData {
  const pop = (c.LIVE_PPLTN_STTS as Raw[] | undefined)?.[0];
  const roadAll = c.ROAD_TRAFFIC_STTS as Raw | undefined;
  const roadAvg = roadAll?.AVG_ROAD_DATA as Raw | undefined;
  const weather = (c.WEATHER_STTS as Raw[] | undefined)?.[0];

  const links: RoadLink[] = ((roadAll?.ROAD_TRAFFIC_STTS as Raw[] | undefined) ?? []).map((l) => ({
    id: str(l.LINK_ID),
    name: str(l.ROAD_NM),
    from: str(l.START_ND_NM),
    to: str(l.END_ND_NM),
    speed: num(l.SPD),
    idx: str(l.IDX),
    path: str(l.XYLIST)
      .split('|')
      .map((p) => p.split('_').map(Number) as [number, number])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
  }));

  const lots: ParkingLot[] = ((c.PRK_STTS as Raw[] | undefined) ?? []).map((p) => {
    const rate = num(p.RATES);
    const per = num(p.TIME_RATES);
    return {
      id: str(p.PRK_CD),
      name: str(p.PRK_NM).replace(/^서울\s?송파\s?/, '').trim() || str(p.PRK_NM),
      capacity: num(p.CPCTY),
      lat: num(p.LAT),
      lng: num(p.LNG),
      address: str(p.ADDRESS),
      fee: rate && per ? `${per}분 ${rate.toLocaleString('ko-KR')}원` : null,
    };
  });

  const stations: Station[] = ((c.SUB_STTS as Raw[] | undefined) ?? []).map((s) => ({
    name: str(s.SUB_STN_NM),
    line: str(s.SUB_STN_LINE),
    lat: num(s.SUB_STN_Y),
    lng: num(s.SUB_STN_X),
  }));

  const controls: Control[] = ((c.ACDNT_CNTRL_STTS as Raw[] | undefined) ?? []).map((a, i) => ({
    id: `city-${i}`,
    kind: str(a.ACDNT_TYPE) || '통제',
    info: str(a.ACDNT_INFO),
    from: str(a.ACDNT_OCCR_DT) || null,
    to: str(a.EXP_CLR_DT) || null,
    distanceM: 0,
    lat: num(a.ACDNT_Y) || null,
    lng: num(a.ACDNT_X) || null,
  }));

  return {
    population: pop
      ? {
          level: str(pop.AREA_CONGEST_LVL),
          message: str(pop.AREA_CONGEST_MSG),
          min: num(pop.AREA_PPLTN_MIN),
          max: num(pop.AREA_PPLTN_MAX),
          at: str(pop.PPLTN_TIME),
          forecast: ((pop.FCST_PPLTN as Raw[] | undefined) ?? []).map((f) => ({
            at: str(f.FCST_TIME),
            level: str(f.FCST_CONGEST_LVL),
          })),
        }
      : null,
    road: roadAvg
      ? {
          level: str(roadAvg.ROAD_TRAFFIC_IDX),
          speed: num(roadAvg.ROAD_TRAFFIC_SPD),
          message: str(roadAvg.ROAD_MSG),
          at: str(roadAvg.ROAD_TRAFFIC_TIME),
          links,
        }
      : null,
    weather: weather
      ? {
          temp: num(weather.TEMP),
          sky: str(((weather.FCST24HOURS as Raw[] | undefined) ?? [])[0]?.SKY_STTS) || null,
          precipType: str(weather.PRECPT_TYPE),
          message: str(weather.PCP_MSG),
          pm10Level: str(weather.PM10_INDEX),
          at: str(weather.WEATHER_TIME),
        }
      : null,
    lots,
    stations,
    controls,
  };
}
