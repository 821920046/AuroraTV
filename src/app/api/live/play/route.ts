import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getChannel } from "@/lib/live";

export const dynamic = "force-dynamic";

// 只返回可供客户端【直连】的直播流地址，绝不中转视频流。
export async function GET(req: NextRequest) {
	const id = req.nextUrl.searchParams.get("id");
	if (!id) return NextResponse.json({ code: 400, msg: "missing id" }, { status: 400 });

	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return NextResponse.json({ code: 404, msg: "no db" }, { status: 404 });

	const ch = await getChannel(env.AURORA_DB, id);
	if (!ch) return NextResponse.json({ code: 404, msg: "channel not found" }, { status: 404 });

	return NextResponse.json({
		code: 200,
		url: ch.stream_url,
		name: ch.name,
		epg_id: ch.epg_id ?? null,
		flags: ch.flags,
	});
}
