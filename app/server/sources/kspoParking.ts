import { cached } from '../cache.ts';
import { env } from '../env.ts';
import { fetchText } from '../http.ts';
import { kstStamp } from '../time.ts';

/**
 * 한국체육산업개발 실시간 주차현황(공공데이터포털 15168686).
 * 동2문·남2문·북2문 주차구역의 현재 주차대수 합계 하나만 준다.
 */
export function getParkingSum(): Promise<{ sum: number; at: string }> {
  return cached('kspo-parking', 60_000, async () => {
    const text = await fetchText(
      `https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=${encodeURIComponent(env.kspoParkingKey)}`,
    );
    const data = JSON.parse(text) as { parking_sum: number | string }[];
    const sum = Number(data?.[0]?.parking_sum);
    if (!Number.isFinite(sum)) throw new Error('parking_sum 없음');
    return { sum, at: kstStamp() };
  });
}
