import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runHealthCheck } from "@/lib/health";

// 由 workers/scheduler 或外部定时服务调用，需携带 ?secret=CRON_SECRET
// 可选调参：?limit= 单次探活源数 ?probes= 每源探测次数 ?streak= 连续失败几轮自动停用
export async function GET(req: NextRequest) {
	const { env } = getCloudflareContext();
	const secret = req.nextUrl.searchParams.get("secret");
	if (!env.CRON_SECRET || secret !== env.CRON_SECRET)
		return NextResponse.json({ code: 401 }, { status: 401 });
	if (!env.AURORA_DB) return NextResponse.json({ code: 500, msg: "no db" }, { status: 500 });

	const sp = req.nextUrl.searchParams;
	const num = (k: string) => {
		const v = Number(sp.get(k));
		return Number.isFinite(v) && v > 0 ? v : undefined;
	};
	const result = await runHealthCheck(env.AURORA_DB, {
		limit: num("limit"),
		probes: num("probes"),
		streak: num("streak"),
	});
	return NextResponse.json({ code: 200, ...result });
}
