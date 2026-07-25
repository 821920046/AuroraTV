import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fetchDetail, parseAllGroups, pickPlayGroup, type Episode } from "@/lib/aggregator";
import { getAllSources } from "@/lib/sources";
import { getSourceHealthMap } from "@/lib/db";
import { TokenMinter, getProxySecret } from "@/lib/proxy";

export const dynamic = "force-dynamic";

// ============================================================================
// 取播放地址
// ----------------------------------------------------------------------------
// 返回两套地址：
//   direct ：上游原地址（Safari/iOS 原生 HLS、或源本身就带 CORS 时最省流量）
//   proxy  ：同源签名代理地址（解决 http 混合内容 / 无 CORS / 防盗链）
// 并给出 prefer 建议：只要上游是 http，或者健康表里 cors!==1，就建议走代理。
// 前端拿不到一个地址就死掉的旧行为到此结束。
// ============================================================================

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

		const { env } = getCloudflareContext();
		// 注意：用全量源（含被自动停用的），否则搜索缓存里的旧结果一点就 404
		const sources = await getAllSources(env.AURORA_DB);
		const detail = await fetchDetail(sources, sourceId, vodId);
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
		const minter = new TokenMinter(getProxySecret(env));

		const episodes = await Promise.all(
			chosen.map(async (e, i) => ({
				name: toEpisodeName(e, i),
				url: e.url,
				proxy: await minter.streamUrl(e.url),
				prefer: e.url.startsWith("http://") || !corsOk ? "proxy" : "direct",
			})),
		);

		const current = episodes[ep];
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
			proxy: current.proxy,
			prefer: current.prefer,
			episodes,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("play route failed:", e);
		return NextResponse.json({ code: 502, msg: "获取播放地址失败: " + msg }, { status: 200 });
	}
}
