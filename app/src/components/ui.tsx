import type { ReactNode } from 'react';
import type { Level } from '../../shared/types.ts';
import { LEVEL_LABEL } from '../../shared/types.ts';

/** 상태색 역할. 색만으로 뜻을 전하지 않도록 항상 글자와 함께 쓴다. */
export type Tone = 'good' | 'neutral' | 'warning' | 'serious' | 'critical';

export const levelTone: Record<Level, Tone> = { calm: 'good', normal: 'neutral', busy: 'serious', jam: 'critical' };

export function populationTone(level: string): Tone {
  if (level === '여유') return 'good';
  if (level === '보통') return 'neutral';
  if (level === '약간 붐빔') return 'warning';
  return 'critical';
}

export function roadTone(idx: string): Tone {
  if (idx === '원활') return 'good';
  if (idx === '서행') return 'warning';
  return 'critical';
}

export function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`tag tone-${tone}`}>
      <span className="tag__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function LevelTag({ level }: { level: Level }) {
  return <Tag tone={levelTone[level]}>{LEVEL_LABEL[level]}</Tag>;
}

/** 처방 시각에만 쓰는 도로 안내표지 판(파란 바탕, 흰 테두리 선) */
export function Plate({ children, size = 'lg' }: { children: ReactNode; size?: 'lg' | 'sm' }) {
  return <span className={`plate plate--${size}`}>{children}</span>;
}

export function Card({ title, aside, children, className = '', id }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={id && title ? `${id}-title` : undefined}>
      {(title || aside) && (
        <header className="card__head">
          {title && (
            <h2 className="card__title" id={id ? `${id}-title` : undefined}>
              {title}
            </h2>
          )}
          {aside && <div className="card__aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** 한 세트, 18px, 선 1.5 */
export const Icon = {
  car: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...stroke}>
      <path d="M5 16V11.5L6.8 7.2A2 2 0 0 1 8.6 6h6.8a2 2 0 0 1 1.8 1.2L19 11.5V16" />
      <path d="M4 16h16v2.5a.5.5 0 0 1-.5.5H18a1 1 0 0 1-1-1v-.5H7v.5a1 1 0 0 1-1 1H4.5a.5.5 0 0 1-.5-.5z" />
      <path d="M5.5 11.5h13" />
    </svg>
  ),
  train: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...stroke}>
      <rect x="6" y="3.5" width="12" height="13" rx="3" />
      <path d="M6 10.5h12M9.5 13.5h.01M14.5 13.5h.01M8.5 20.5l1.5-4M15.5 20.5l-1.5-4" />
    </svg>
  ),
  exit: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...stroke}>
      <path d="M14 4h4.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M4 12h11M11 8l4 4-4 4" />
    </svg>
  ),
  walk: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...stroke}>
      <circle cx="13" cy="4.5" r="1.5" />
      <path d="M9.5 21l2.5-6.5 2.5 2.5V21M8 12.5l2.5-5h3l2.5 4.5 2.5 1M12 7.5l-1 7" />
    </svg>
  ),
  alert: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...stroke}>
      <path d="M12 4l9 15.5H3z" />
      <path d="M12 10v4M12 16.8h.01" />
    </svg>
  ),
};
