import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { aggregateSearch } from "@/lib/aggregator";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { getSourceHealthMap } from "@/lib/db";

export async function GET(req: NextRequest) {
	const kw = req.nextUrl.searchParams.get("wd")?.trim();
	if (!kw) return NextResponse.json({ code: 400, msg: "missing wd" }, { status: 400 });

	const { env } = getCloudflareContext();
	const key = makeCacheKey("search", kw);

	const cached = await cacheGetWithKv(key, env);
	if (cached) return NextResponse.json({ code: 200, cached: true, list: cached });

	const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : undefined;
	const list = await aggregateSearch(kw, health);

	// 搜索结果变更较快，不写 KV（persist=false），仅走边缘缓存
	await cacheSetWithKv(key, list, env, 60 * 60 * 6, false);
	return NextResponse.json({ code: 200, cached: false, list });
}
