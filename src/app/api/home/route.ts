import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { aggregateRecent, classifyRecent } from "@/lib/aggregator";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { getSourceHealthMap } from "@/lib/db";
import { getEnabledSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

// 首页「近期热播」：从启用的片源拉取最近更新的电影/电视剧（含海报）。
// 结果变化较慢，缓存 3h 并写 KV 兜底，减少对采集源的重复请求。
export async function GET() {
	try {
		const { env } = getCloudflareContext();
		const key = makeCacheKey("home", "v1");

		const cached = await cacheGetWithKv<{ movies: unknown[]; tv: unknown[] }>(key, env);
		if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });

		const sources = await getEnabledSources(env.AURORA_DB);
		const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : undefined;
		const recent = await aggregateRecent(sources, health);
		const { movies, tv } = classifyRecent(recent);
		const result = { movies: movies.slice(0, 12), tv: tv.slice(0, 12) };

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
