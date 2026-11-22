import { useLayoutEffect, useState } from 'react';

/**
 * 요소의 실제 폭을 잰다. SVG 를 viewBox 로 늘리면 글자까지 같이 줄어들기 때문에,
 * 차트와 지도는 이 폭으로 직접 그려 글자 크기를 유지한다.
 * 콜백 ref 를 돌려주므로 요소가 바뀌어도(표 보기 전환 등) 다시 관찰한다.
 */
export function useWidth<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width || fallback];
}
