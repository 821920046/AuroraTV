import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { aggregateRecent, type RecentItem } from "@/lib/aggregator";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { getSourceHealthMap } from "@/lib/db";
import { getEnabledSources } from "@/lib/sources";
import { TokenMinter, getProxySecret } from "@/lib/proxy";

export const dynamic = "force-dynamic";

// 首页「近期热播」。变化慢，缓存 3h 并写 KV 兜底。
// 变更：不再只取「网页可直播」的源（代理已解决可播性），海报一律代理避免碎图。
async function withProxiedPosters(items: RecentItem[], minter: TokenMinter) {
	return Promise.all(
		items.map(async (it) => ({ ...it, poster: it.poster ? await minter.imageUrl(it.poster) : null })),
	);
}

export async function GET() {
	try {
		const { env } = getCloudflareContext();
		const key = makeCacheKey("home", "v2");

		const cached = await cacheGetWithKv<{ movies: unknown[]; tv: unknown[] }>(key, env);
		if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });

		const sources = await getEnabledSources(env.AURORA_DB);
		const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : undefined;
		const { movies, tv } = await aggregateRecent(sources, health, 4);

		const minter = new TokenMinter(getProxySecret(env));
		const result = {
			movies: await withProxiedPosters(movies.slice(0, 18), minter),
			tv: await withProxiedPosters(tv.slice(0, 18), minter),
		};

		if (result.movies.length || result.tv.length)
			await cacheSetWithKv(key, result, env, 60 * 60 * 3, true);
		return NextResponse.json({ code: 200, cached: false, ...result });
	} catch (e) {
		console.error("home route failed:", e);
		return NextResponse.json(
			{ code: 200, movies: [], tv: [], error: e instanceof Error ? e.message : String(e) },
			{ status: 200 },
		);
	}
}
