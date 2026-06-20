// 缓存层：Cache API 优先 + KV 兜底。
// 关键：所有缓存访问都做容错——缓存失败绝不能让业务接口 500。
// 注意 caches.default 是 Cloudflare 专有扩展，在某些运行时（OpenNext 的标准
// CacheStorage）可能不存在，必须先判空再用。

export type CacheEnv = {
  AURORA_KV?: KVNamespace;
};

const DEFAULT_TTL = 60 * 60 * 6; // 6h
const CACHE_HOST = "cache.auroratv.internal";

function getDefaultCache(): Cache | null {
  try {
    const c = (caches as unknown as { default?: Cache }).default;
    return c ?? null;
  } catch {
    return null;
  }
}

function cacheKeyToRequest(key: string): Request {
  const url = "https://" + CACHE_HOST + "/" + encodeURIComponent(key);
  return new Request(url);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const cache = getDefaultCache();
    if (!cache) return null;
    const hit = await cache.match(cacheKeyToRequest(key));
    if (hit) return (await hit.json()) as T;
  } catch (e) {
    console.error("cacheGet failed:", e);
  }
  return null;
}

export async function cacheGetWithKv<T>(key: string, env: CacheEnv): Promise<T | null> {
  const edge = await cacheGet<T>(key);
  if (edge !== null) return edge;
  try {
    if (env.AURORA_KV) {
      const raw = await env.AURORA_KV.get(key);
      if (raw) {
        const value = JSON.parse(raw) as T;
        await cacheSet(key, value, DEFAULT_TTL);
        return value;
      }
    }
  } catch (e) {
    console.error("cacheGetWithKv KV failed:", e);
  }
  return null;
}

export async function cacheSet<T>(key: string, value: T, ttl = DEFAULT_TTL): Promise<void> {
  try {
    const cache = getDefaultCache();
    if (!cache) return;
    const res = new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json", "cache-control": "max-age=" + ttl },
    });
    await cache.put(cacheKeyToRequest(key), res);
  } catch (e) {
    console.error("cacheSet failed:", e);
  }
}

export async function cacheSetWithKv<T>(
  key: string,
  value: T,
  env: CacheEnv,
  ttl = DEFAULT_TTL,
  persist = false,
): Promise<void> {
  await cacheSet(key, value, ttl);
  try {
    if (persist && env.AURORA_KV) {
      await env.AURORA_KV.put(key, JSON.stringify(value), { expirationTtl: ttl });
    }
  } catch (e) {
    console.error("cacheSetWithKv KV failed:", e);
  }
}

export function makeCacheKey(type: string, id: string, params?: Record<string, unknown>): string {
  const p = params ? ":" + hashString(JSON.stringify(params)) : "";
  return type + ":" + id + p;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
