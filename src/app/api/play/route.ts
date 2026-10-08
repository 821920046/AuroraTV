import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fetchDetail, parseAllGroups, pickPlayGroup, type Episode } from "@/lib/aggregator";
import { getAllSources } from "@/lib/sources";
import { getSourceHealthMap } from "@/lib/db";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { TokenMinter } from "@/lib/proxy";
import { resolveProxySecret } from "@/lib/secret";
import { checkRateLimit, rateLimitedResponse } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

// ============================================================================
// 取播放地址
// ----------------------------------------------------------------------------
// 返回两套地址：
//   direct ：上游原地址（Safari/iOS 原生 HLS、或源本身就带 CORS 时最省流量）
//   proxy  ：同源签名代理地址（解决 http 混合内容 / 无 CORS / 防盗链）
// 并给出 prefer 建议：只要上游是 http，或者健康表里 cors!==1，就建议走代理。
//
// 【本端点的两个关键改动，都是「按需」二字】
//
// 1) 详情走缓存。
//    旧实现每次调用都 fetchDetail()，也就是每次切集都重新打一次上游详情接口。
//    一部 40 集的剧从头看到尾 = 40 次上游请求，慢且极易触发上游限流。
//    现在复用 /api/detail 的缓存键，切集命中缓存后零上游请求。
//
// 2) 只为「当前这一集」签发地址。
//    旧实现返回 episodes[] 里每一项都带 url + proxy：100 集就是 200 个 URL，
//    响应体轻松上 100KB，而且等于把所有线路的签名令牌一次性全发给客户端。
//    现在 episodes[] 只回名字，前端切集时带 ep 重新请求 —— 命中上面的缓存，
//    代价只是一次边缘缓存读，比传 100KB 划算得多。
// ============================================================================

/** 详情缓存时长。片源会陆续更新集数，6h 是「够省上游」与「不太滞后」的折中。 */
const DETAIL_TTL = 60 * 60 * 6;

function toEpisodeName(e: Episode, i: number): string {
	return e.name || `第${i + 1}集`;
}

export async function GET(req: NextRequest) {
	try {
		const sp = req.nextUrl.searchParams;
		const sourceId = sp.get("source");
		const vodId = sp.get("id");
		const epRaw = Number(sp.get("ep") ?? "0");
		const groupRaw = Number(sp.get("group") ?? "-1");
		if (!sourceId || !vodId)
			return NextResponse.json({ code: 400, msg: "缺少 source 或 id" }, { status: 200 });

		const rl = await checkRateLimit(req);
		if (rl.limited) return rateLimitedResponse(rl);

		const { env } = getCloudflareContext();
		// 注意：用全量源（含被自动停用的），否则搜索缓存里的旧结果一点就 404
		const sources = await getAllSources(env.AURORA_DB);

		// 与 /api/detail 共用缓存键，两边谁先写入都算数。
		// persist=false：只写边缘缓存，不写 KV —— KV 免费额度只有 1000 写/天，
		// 而 /api/play 是最高频的入口，用它当持久化层会把额度烧光。
		// 边缘缓存已经足以消除「切集重复打上游」这个核心问题。
		const cacheKey = makeCacheKey("detail", `${sourceId}:${vodId}`);
		let detail = await cacheGetWithKv<Record<string, unknown>>(cacheKey, env);
		if (!detail) {
			detail = await fetchDetail(sources, sourceId, vodId);
			if (detail) await cacheSetWithKv(cacheKey, detail, env, DETAIL_TTL);
		}
		if (!detail) return NextResponse.json({ code: 404, msg: "未找到资源详情" }, { status: 200 });

		const rawUrl = String(detail.vod_play_url ?? "");
		const rawFrom = String(detail.vod_play_from ?? "");
		const groups = parseAllGroups(rawUrl, rawFrom);
		const chosen =
			groupRaw >= 0 && groups[groupRaw] ? groups[groupRaw].episodes : pickPlayGroup(rawUrl, rawFrom);
		if (chosen.length === 0)
			return NextResponse.json({ code: 404, msg: "该资源没有可用播放地址" }, { status: 200 });

		const ep = Number.isFinite(epRaw) && epRaw >= 0 && epRaw < chosen.length ? epRaw : 0;

		const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : {};
		const corsOk = health[sourceId]?.cors === 1;
		const { secret } = await resolveProxySecret(env);
		const minter = new TokenMinter(secret);

		// 只为「当前这一集」签发地址。其余集数只回名字 ——
		// 前端切集时带 ep 重新请求本端点，命中上面的详情缓存，不会再打上游。
		const current = chosen[ep];
		const prefer: "direct" | "proxy" =
			current.url.startsWith("http://") || !corsOk ? "proxy" : "direct";

		return NextResponse.json({
			code: 200,
			source_id: sourceId,
			source_name: sources.find((s) => s.id === sourceId)?.name ?? sourceId,
			title: String(detail.vod_name ?? ""),
			// 海报必须走代理：它会被用作 <video poster>，而采集站图床既可能是 http（混合内容）
			// 又没有 CORS 头（被当作跨域图片拒绝）。
			pic: detail.vod_pic ? await minter.imageUrl(String(detail.vod_pic)) : null,
			desc: String(detail.vod_content ?? "")
				.replace(/<[^>]+>/g, "")
				.slice(0, 400),
			year: detail.vod_year ? String(detail.vod_year) : null,
			area: detail.vod_area ? String(detail.vod_area) : null,
			actor: String(detail.vod_actor ?? "").slice(0, 200),
			group: groupRaw >= 0 && groups[groupRaw] ? groupRaw : groups.findIndex((g) => g.episodes[0]?.url === chosen[0]?.url),
			groups: groups.map((g, i) => ({ index: i, from: g.from, count: g.episodes.length })),
			ep,
			url: current.url,
			proxy: await minter.streamUrl(current.url),
			prefer,
			// 只有名字，没有地址 —— 这是本次瘦身的核心
			episodes: chosen.map((e, i) => ({ name: toEpisodeName(e, i) })),
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("play route failed:", e);
		return NextResponse.json({ code: 502, msg: "获取播放地址失败: " + msg }, { status: 200 });
	}
}
