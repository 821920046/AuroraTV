import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fetchDetail, pickPlayGroup } from "@/lib/aggregator";
import { getEnabledSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

// 注意：本接口只返回可供客户端【直连】的播放地址，绝不中转视频流。
// 所有异常都包装成 JSON，避免前端收到 500/HTML 后 json() 报错，表现为“点击没反应”。
export async function GET(req: NextRequest) {
	try {
		const sourceId = req.nextUrl.searchParams.get("source");
		const vodId = req.nextUrl.searchParams.get("id");
		const ep = Number(req.nextUrl.searchParams.get("ep") ?? "0");
		if (!sourceId || !vodId)
			return NextResponse.json({ code: 400, msg: "缺少 source 或 id" }, { status: 400 });

		const { env } = getCloudflareContext();
		const sources = await getEnabledSources(env.AURORA_DB);
		const detail = await fetchDetail(sources, sourceId, vodId);
		if (!detail) return NextResponse.json({ code: 404, msg: "未找到资源详情" }, { status: 404 });

		const rawUrl = String(detail.vod_play_url ?? "");
		const rawFrom = String(detail.vod_play_from ?? "");
		const episodes = pickPlayGroup(rawUrl, rawFrom);

		const current = episodes[Number.isFinite(ep) ? ep : 0] ?? episodes[0];
		if (!current?.url) return NextResponse.json({ code: 404, msg: "该资源没有可用播放地址" }, { status: 404 });

		return NextResponse.json({ code: 200, url: current.url, episodes });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("play route failed:", e);
		return NextResponse.json({ code: 502, msg: "获取播放地址失败: " + msg }, { status: 200 });
	}
}
