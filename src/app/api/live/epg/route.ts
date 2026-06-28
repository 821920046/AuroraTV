import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getEpgNowNext } from "@/lib/live";
import { cacheGet, cacheSet, makeCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

// 返回某频道「正在播 / 稍后播」。无 EPG 数据时优雅返回空。
export async function GET(req: NextRequest) {
	const epgId = req.nextUrl.searchParams.get("epgId")?.trim();
	if (!epgId) return NextResponse.json({ code: 400, msg: "missing epgId" }, { status: 400 });

	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return NextResponse.json({ code: 200, now: null, next: null });

	const key = makeCacheKey("live_epg", epgId);
	const cached = await cacheGet<{ now: unknown; next: unknown }>(key);
	if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });

	const data = await getEpgNowNext(env.AURORA_DB, epgId);
	const payload = { now: data.now ?? null, next: data.next ?? null };
	await cacheSet(key, payload, 60 * 5);
	return NextResponse.json({ code: 200, cached: false, ...payload });
}
