// 서울시 돌발정보의 grs80tm_x/y 는 GRS80 중부원점 TM(EPSG:5181: 위도 38°, 경도 127°, 가산 200000/500000)이다.
const a = 6378137;
const f = 1 / 298.257222101;
const e2 = 2 * f - f * f;
const ep2 = e2 / (1 - e2);
const k0 = 1;
const lat0 = (38 * Math.PI) / 180;
const lon0 = (127 * Math.PI) / 180;
const x0 = 200000;
const y0 = 500000;

function meridian(phi: number): number {
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return (
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

const M0 = meridian(lat0);

export function toTm(lat: number, lng: number): { x: number; y: number } {
  const phi = (lat * Math.PI) / 180;
  const lam = (lng * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = (lam - lon0) * Math.cos(phi);
  const x = x0 + k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120);
  const y =
    y0 +
    k0 *
      (meridian(phi) -
        M0 +
        N *
          Math.tan(phi) *
          ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x, y };
}

export function fromTm(x: number, y: number): { lat: number; lng: number } {
  const M1 = M0 + (y - y0) / k0;
  const mu = M1 / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = (x - x0) / (N1 * k0);
  const phi =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lam =
    lon0 +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
      Math.cos(phi1);
  return { lat: (phi * 180) / Math.PI, lng: (lam * 180) / Math.PI };
}

/** 올림픽공원 중심(KOPIS 시설 좌표 부근) */
export const PARK_CENTER = { lat: 37.5207, lng: 127.1215 };
