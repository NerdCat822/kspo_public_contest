import { maskSecrets } from './env.ts';

/** 공공 API 는 간헐적으로 4xx/5xx 를 돌려주므로 한 번 다시 시도한다. */
export async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  try {
    return await fetchOnce(url, timeoutMs);
  } catch {
    await new Promise((r) => setTimeout(r, 700));
    return fetchOnce(url, timeoutMs);
  }
}

async function fetchOnce(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'gilmak-doctor/0.1' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(maskSecrets(`${msg} (${url.split('?')[0]})`));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, timeoutMs?: number): Promise<T> {
  const text = await fetchText(url, timeoutMs);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(maskSecrets(`JSON 형식이 아님: ${text.slice(0, 120)}`));
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return ENTITIES[e] ?? String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    })
    .trim();
}

/** 단순한 공공 API XML(반복 블록 + 평문 필드)을 읽는다. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

export function xmlText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : '';
}
