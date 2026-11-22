import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { env } from './env.ts';

interface Entry<T> {
  value: T;
  expires: number;
}

const memory = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * TTL 캐시. 같은 키로 동시에 들어온 요청은 한 번만 호출한다.
 * persist=true 면 디스크(data/cache)에도 저장해 재시작해도 외부 API를 다시 부르지 않는다.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, persist = false): Promise<T> {
  const now = Date.now();
  const hit = memory.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;

  if (persist) {
    const disk = readDisk<T>(key);
    if (disk && disk.expires > now) {
      memory.set(key, disk);
      return disk.value;
    }
  }

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const p = load()
    .then((value) => {
      const entry = { value, expires: Date.now() + ttlMs };
      memory.set(key, entry);
      if (persist) writeDisk(key, entry);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function diskPath(key: string): string {
  return path.join(env.dataDir, 'cache', `${key.replace(/[^\w.-]+/g, '_')}.json`);
}

function readDisk<T>(key: string): Entry<T> | null {
  const file = diskPath(key);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Entry<T>;
  } catch {
    return null;
  }
}

function writeDisk<T>(key: string, entry: Entry<T>): void {
  try {
    mkdirSync(path.dirname(diskPath(key)), { recursive: true });
    writeFileSync(diskPath(key), JSON.stringify(entry));
  } catch {
    // 디스크 캐시는 선택 사항이라 실패해도 무시한다.
  }
}
