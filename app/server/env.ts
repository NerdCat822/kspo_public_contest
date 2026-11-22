import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** app/.env 와 저장소 루트 .env 를 읽는다. 이미 설정된 환경변수가 우선한다. */
function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const files = [path.resolve(process.cwd(), '..', '.env'), path.resolve(process.cwd(), '.env')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

const fileEnv = loadDotEnv();
const pick = (name: string, fallback = '') => process.env[name] ?? fileEnv[name] ?? fallback;

export const env = {
  kopisKey: pick('KOPIS_API_KEY'),
  seoulKey: pick('SEOUL_API_KEY') || pick('SEOUL_OPENDATA_API_KEY'),
  dataGoKrKey: pick('DATA_GO_KR_KEY') || pick('PUBLIC_DATA_API_KEY'),
  cultureKey: pick('CULTURE_API_KEY'),
  /** 한국체육산업개발이 공공데이터 개방목록에 공개한 실시간 주차현황 키 */
  kspoParkingKey: pick('KSPO_PARKING_KEY', 'PARKING21803504'),
  dataDir: pick('GILMAK_DATA_DIR', path.resolve(process.cwd(), 'data')),
};

/** 오류 메시지에 키가 섞여 나가지 않도록 가린다. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const secret of [env.kopisKey, env.seoulKey, env.dataGoKrKey, env.cultureKey]) {
    if (!secret) continue;
    out = out.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
  }
  return out;
}

/** data.go.kr 키는 인코딩된 형태(%포함)와 디코딩된 형태 둘 다 올 수 있다. */
export function queryKey(key: string): string {
  return key.includes('%') ? key : encodeURIComponent(key);
}
