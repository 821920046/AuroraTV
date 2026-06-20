import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fetchDetail, parsePlayUrl } from "@/lib/aggregator";
import { getEnabledSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

// 注意：本接口只返回可供客户端【直连】的播放地址，绝不中转视频流。
export async function GET(req: NextRequest) {
	const sourceId = req.nextUrl.searchParams.get("source");
	const vodId = req.nextUrl.searchParams.get("id");
	const ep = Number(req.nextUrl.searchParams.get("ep") ?? "0");
	if (!sourceId || !vodId)
		return NextResponse.json({ code: 400, msg: "missing source/id" }, { status: 400 });

	const { env } = getCloudflareContext();
	const sources = await getEnabledSources(env.AURORA_DB);
	const detail = await fetchDetail(sources, sourceId, vodId);
	const raw = String(detail?.vod_play_url ?? "");
	const episodes = parsePlayUrl(raw);

	const current = episodes[ep] ?? episodes[0];
	if (!current) return NextResponse.json({ code: 404, msg: "no playable url" }, { status: 404 });

	return NextResponse.json({ code: 200, url: current.url, episodes });
}
