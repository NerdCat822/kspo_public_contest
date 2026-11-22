const WEEKDAY_FULL: Record<string, string> = { 일: '일요일', 월: '월요일', 화: '화요일', 수: '수요일', 목: '목요일', 금: '금요일', 토: '토요일' };

export function dateLong(date: string, weekday: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일 ${WEEKDAY_FULL[weekday] ?? weekday}`;
}

export function monthDay(date: string): { m: number; d: number } {
  const [, m, d] = date.split('-').map(Number);
  return { m, d };
}

export const num = (n: number) => n.toLocaleString('ko-KR');

/** 'YYYY-MM-DD HH:MM' → 'HH:MM' */
export const clock = (stamp: string) => stamp.slice(11, 16);

/** 한국 시각 기준 지금 HH:MM */
export function nowKstClock(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
}

export const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export function km(m: number | null): string {
  if (m == null) return '';
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

/** '2027-03-01 00:00' → '3월 1일' */
export function shortStamp(stamp: string | null): string {
  if (!stamp) return '';
  const [, m, d] = stamp.slice(0, 10).split('-').map(Number);
  return `${m}월 ${d}일`;
}
