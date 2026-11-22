// 모든 날짜·시각은 한국 표준시(KST) 기준으로 다룬다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** KST 벽시계 값을 UTC 필드에 담은 Date (getUTC*로 읽는다) */
export function kstNow(): Date {
  return new Date(Date.now() + KST_OFFSET_MS);
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayKst(): string {
  return ymd(kstNow());
}

export function parseYmd(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s)!;
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

export function weekdayOf(s: string): number {
  return parseYmd(s)!.getUTCDay(); // 0=일
}

export function hhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** 'YYYY-MM-DD HH:MM' 형태의 KST 시각 문자열 */
export function kstStamp(d: Date = kstNow()): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
