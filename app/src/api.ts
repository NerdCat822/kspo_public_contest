import type { DayResponse, LiveResponse, OverviewDay } from '../shared/types.ts';

type WithErrors<T> = T & { errors: Record<string, string> };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return (await res.json()) as T;
}

export const api = {
  overview: () => get<{ days: OverviewDay[]; errors: Record<string, string> }>('/api/overview?days=14'),
  day: (date: string) => get<WithErrors<DayResponse>>(`/api/day?date=${date}`),
  live: () => get<LiveResponse>('/api/live'),
};

export type DayData = WithErrors<DayResponse>;
