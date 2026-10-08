import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { aggregateSearch } from "@/lib/aggregator";
import { getEnabledSources } from "@/lib/sources";
import { getSourceHealthMap } from "@/lib/db";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { TokenMinter } from "@/lib/proxy";
import { resolveProxySecret } from "@/lib/secret";
import { checkRateLimit, rateLimitedResponse } from "@/lib/ratelimit";

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

	// 搜索是最贵的端点：一次请求会扇出到 8 个上游。放在参数校验之后、
	// 任何上游调用之前 —— 限流的意义就是不让请求走到 fetchJson。
	const rl = await checkRateLimit(req);
	if (rl.limited) return rateLimitedResponse(rl);

	try {
		const { env } = getCloudflareContext();

		// 片源集合先读：它既是搜索的前提，也是缓存键的一部分。
		const sources = await getEnabledSources(env.AURORA_DB);
		if (sources.length === 0)
			return NextResponse.json({ code: 503, msg: "没有可用片源，请先在后台导入片源", list: [] });

		// 缓存键必须绑定「当前片源集合」。
		// 病因：原键只含 { v: 2 } 这个手改的版本号，站长导入 / 删除 / 启停片源后，
		// 用户仍会命中 30 分钟前的旧结果，表现为「后台明明加了源，前台却搜不到」。
		// 用排序后的 id:weight 做指纹，集合一变键就变，无需人工改版本号。
		const srcFingerprint = sources
			.map((s) => `${s.id}:${s.weight ?? 0}`)
			.sort()
			.join(",");
		const key = makeCacheKey("search", kw.toLowerCase(), { v: 3, src: srcFingerprint });

		const cached = await cacheGetWithKv<{ list: unknown[]; total: number }>(key, env);
		if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });

		const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : undefined;
		const items = await aggregateSearch(kw, sources, health);

		// 海报一律走同源代理，消除 http 混合内容导致的满屏碎图
		const { secret } = await resolveProxySecret(env);
		const minter = new TokenMinter(secret);
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
