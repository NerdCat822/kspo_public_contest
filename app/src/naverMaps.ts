/**
 * 네이버 지도 JavaScript API v3 불러오기(네이버 클라우드 플랫폼 Maps · Dynamic Map).
 *
 * - 스크립트 주소의 ncpKeyId 에 Maps Application 의 Client ID 를 붙인다. Client ID 는 백엔드 /api/config 에서 받는다.
 * - 지도를 여는 주소의 도메인을 콘솔 Maps › Application 의 Web 서비스 URL 에 등록해야 한다(포트·경로 없이).
 *   등록하지 않은 주소에서는 navermap_authFailure 가 불린다.
 * - 스크립트는 한 번만 넣는다.
 */

const SCRIPT_URL = 'https://oapi.map.naver.com/openapi/v3/maps.js';
const LOAD_TIMEOUT_MS = 20_000;

export type NaverMaps = typeof naver.maps;

export class MapLoadError extends Error {
  reason: 'auth' | 'script' | 'timeout';
  constructor(reason: 'auth' | 'script' | 'timeout', message: string) {
    super(message);
    this.reason = reason;
  }
}

declare global {
  interface Window {
    navermap_authFailure?: () => void;
  }
}

let loading: Promise<NaverMaps> | null = null;
let authFailed = false;
const authListeners = new Set<() => void>();

/** 인증 실패는 스크립트를 받은 뒤에도 늦게 올 수 있어서, 지도를 그린 쪽에서도 알림을 받는다. */
export function onAuthFailure(listener: () => void): () => void {
  if (authFailed) listener();
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function loadNaverMaps(clientId: string): Promise<NaverMaps> {
  if (loading) return loading;
  loading = new Promise<NaverMaps>((resolve, reject) => {
    window.navermap_authFailure = () => {
      authFailed = true;
      authListeners.forEach((l) => l());
      reject(new MapLoadError('auth', `네이버 지도 인증에 실패했어요. 콘솔 Web 서비스 URL 에 ${window.location.origin} 을 등록했는지 확인해 주세요.`));
    };
    const timer = window.setTimeout(() => reject(new MapLoadError('timeout', '네이버 지도 스크립트가 응답하지 않아요.')), LOAD_TIMEOUT_MS);
    const script = document.createElement('script');
    script.src = `${SCRIPT_URL}?ncpKeyId=${encodeURIComponent(clientId)}`;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      const ns = (window as Window & { naver?: { maps?: NaverMaps } }).naver;
      if (ns?.maps) resolve(ns.maps);
      else reject(new MapLoadError('script', '네이버 지도 스크립트를 불러왔지만 지도를 만들 수 없어요.'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new MapLoadError('script', '네이버 지도 스크립트를 내려받지 못했어요.'));
    };
    document.head.appendChild(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
