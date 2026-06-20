import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fetchDetail } from "@/lib/aggregator";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { getEnabledSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const sourceId = req.nextUrl.searchParams.get("source");
	const vodId = req.nextUrl.searchParams.get("id");
	if (!sourceId || !vodId)
		return NextResponse.json({ code: 400, msg: "missing source/id" }, { status: 400 });

	const { env } = getCloudflareContext();
	const key = makeCacheKey("detail", `${sourceId}:${vodId}`);

	const cached = await cacheGetWithKv(key, env);
	if (cached) return NextResponse.json({ code: 200, cached: true, detail: cached });

	const sources = await getEnabledSources(env.AURORA_DB);
	const detail = await fetchDetail(sources, sourceId, vodId);
	if (!detail) return NextResponse.json({ code: 404, msg: "not found" }, { status: 404 });

	// 详情是高价值、低频变更 → persist=true 写入 KV 兜底，TTL 24h
	await cacheSetWithKv(key, detail, env, 60 * 60 * 24, true);
	return NextResponse.json({ code: 200, cached: false, detail });
}
