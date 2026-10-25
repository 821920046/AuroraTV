import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runHealthCheck } from "@/lib/health";
import { isCronAuthorized } from "@/lib/cronAuth";

// 由 workers/scheduler 或外部定时服务调用。
// 推荐 Authorization: Bearer <CRON_SECRET>；?secret= 仅为兼容旧部署而保留
// （查询串会把密钥写进访问日志）。两种方式的比较都是定长的。
// 可选调参：?limit= 单次探活源数 ?probes= 每源探测次数 ?streak= 连续失败几轮自动停用
export async function GET(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!isCronAuthorized(req, env.CRON_SECRET))
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
