// 缓存层：Cache API 优先 + KV 兜底
// Cache API 不计入 KV 配额（免费 KV 仅 1000 写/天），所以优先用它。

export type CacheEnv = {
	AURORA_KV?: KVNamespace;
};

const DEFAULT_TTL = 60 * 60 * 6; // 6h

// 用于 Cache API 的内部域名（分开拼接以避免被当作链接处理）
const CACHE_HOST = "cache.auroratv.internal";

function cacheKeyToRequest(key: string): Request {
	// Cache API 以 Request 为 key，构造一个稳定的内部 URL
	const url = "https://" + CACHE_HOST + "/" + encodeURIComponent(key);
	return new Request(url);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
	const cache = (caches as unknown as { default: Cache }).default;
	const hit = await cache.match(cacheKeyToRequest(key));
	if (hit) {
		try {
			return (await hit.json()) as T;
		} catch {
			/* ignore */
		}
	}
	return null;
}

export async function cacheGetWithKv<T>(key: string, env: CacheEnv): Promise<T | null> {
	const edge = await cacheGet<T>(key);
	if (edge !== null) return edge;
	// KV 兜底（跨节点共享）
	if (env.AURORA_KV) {
		const raw = await env.AURORA_KV.get(key);
		if (raw) {
			const value = JSON.parse(raw) as T;
			await cacheSet(key, value, DEFAULT_TTL); // 回填边缘缓存
			return value;
		}
	}
	return null;
}

export async function cacheSet<T>(key: string, value: T, ttl = DEFAULT_TTL): Promise<void> {
	const cache = (caches as unknown as { default: Cache }).default;
	const res = new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json", "cache-control": "max-age=" + ttl },
	});
	await cache.put(cacheKeyToRequest(key), res);
}

export async function cacheSetWithKv<T>(
	key: string,
	value: T,
	env: CacheEnv,
	ttl = DEFAULT_TTL,
	persist = false, // 仅高价值、低频变更结果写 KV
): Promise<void> {
	await cacheSet(key, value, ttl);
	if (persist && env.AURORA_KV) {
		await env.AURORA_KV.put(key, JSON.stringify(value), { expirationTtl: ttl });
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
