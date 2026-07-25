import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { aggregateSearch } from "@/lib/aggregator";
import { getEnabledSources } from "@/lib/sources";
import { getSourceHealthMap } from "@/lib/db";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { TokenMinter, getProxySecret } from "@/lib/proxy";

export const dynamic = "force-dynamic";

const SEARCH_TTL = 60 * 30;

// 变更说明：取消了 webOnly 过滤。
// 原因：那个开关是为了避开无 CORS 的源而存在的「绕路」，代价是搜索结果大量变空；
// 同源代理上线后无 CORS 也能播，因此回到「全量搜索 + 健康度排序」才是正确解。
export async function GET(req: NextRequest) {
	const sp = req.nextUrl.searchParams;
	const kw = (sp.get("kw") ?? sp.get("q") ?? "").trim();
	if (!kw) return NextResponse.json({ code: 400, msg: "请输入关键词", list: [] }, { status: 200 });
	if (kw.length > 60)
		return NextResponse.json({ code: 400, msg: "关键词过长", list: [] }, { status: 200 });

	try {
		const { env } = getCloudflareContext();
		const key = makeCacheKey("search", kw.toLowerCase(), { v: 2 });

		const cached = await cacheGetWithKv<{ list: unknown[]; total: number }>(key, env);
		if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });

		const sources = await getEnabledSources(env.AURORA_DB);
		if (sources.length === 0)
			return NextResponse.json({ code: 503, msg: "没有可用片源，请先在后台导入片源", list: [] });

		const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : undefined;
		const items = await aggregateSearch(kw, sources, health);

		// 海报一律走同源代理，消除 http 混合内容导致的满屏碎图
		const minter = new TokenMinter(getProxySecret(env));
		const list = await Promise.all(
			items.slice(0, 120).map(async (it) => ({
				...it,
				poster: it.poster ? await minter.imageUrl(it.poster) : null,
			})),
		);

		const payload = { list, total: list.length };
		if (list.length > 0) await cacheSetWithKv(key, payload, env, SEARCH_TTL, false);
		return NextResponse.json({ code: 200, cached: false, ...payload });
	} catch (e) {
		console.error("search failed:", e);
		return NextResponse.json(
			{ code: 502, msg: "搜索失败: " + (e instanceof Error ? e.message : String(e)), list: [] },
			{ status: 200 },
		);
	}
}
