import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	getEnabledLiveSources,
	ingestChannels,
	probeChannels,
	ingestEpg,
} from "@/lib/live";

// 由 workers/scheduler 或外部定时服务调用，需携带 ?secret=CRON_SECRET。
// 默认：摄取频道 + 探活一批。可选 ?ingest=0 跳过摄取，?epg=1 额外拉 EPG。
export async function GET(req: NextRequest) {
	const { env } = getCloudflareContext();
	const secret = req.nextUrl.searchParams.get("secret");
	if (!env.CRON_SECRET || secret !== env.CRON_SECRET)
		return NextResponse.json({ code: 401 }, { status: 401 });
	if (!env.AURORA_DB) return NextResponse.json({ code: 500, msg: "no db" }, { status: 500 });

	const db = env.AURORA_DB;
	const doIngest = req.nextUrl.searchParams.get("ingest") !== "0";
	const doEpg = req.nextUrl.searchParams.get("epg") === "1";

	let ingested = { sources: 0, channels: 0 };
	if (doIngest) {
		const sources = await getEnabledLiveSources(db);
		ingested = await ingestChannels(db, sources);
	}

	const probed = await probeChannels(db, 50);

	let epg = 0;
	if (doEpg) {
		const raw = req.nextUrl.searchParams.get("epgUrls");
		const urls = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
		if (urls.length > 0) epg = await ingestEpg(db, urls, 48);
	}

	return NextResponse.json({ code: 200, ingested, probed, epg });
}
