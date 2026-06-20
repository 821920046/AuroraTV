import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { enabledSources } from "@/lib/sources";
import { upsertSourceHealth } from "@/lib/db";
import { computeScore } from "@/lib/scoring";

// 由 workers/scheduler 或外部定时服务调用，需携带 ?secret=CRON_SECRET
export async function GET(req: NextRequest) {
	const { env } = getCloudflareContext();
	const secret = req.nextUrl.searchParams.get("secret");
	if (!env.CRON_SECRET || secret !== env.CRON_SECRET)
		return NextResponse.json({ code: 401 }, { status: 401 });
	if (!env.AURORA_DB) return NextResponse.json({ code: 500, msg: "no db" }, { status: 500 });

	const now = Date.now();
	const db = env.AURORA_DB;
	const results = await Promise.allSettled(
		enabledSources().map(async (s) => {
			const probes = 3;
			let ok = 0;
			let totalMs = 0;
			let timeouts = 0;
			for (let i = 0; i < probes; i++) {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), 3000);
				const start = Date.now();
				try {
					const r = await fetch(`${s.api}?ac=list`, { signal: ctrl.signal });
					if (r.ok) ok++;
					totalMs += Date.now() - start;
				} catch {
					timeouts++;
					totalMs += 3000;
				} finally {
					clearTimeout(t);
				}
			}
			const successRate = ok / probes;
			const avg = Math.round(totalMs / probes);
			const score = computeScore({ successRate, avgLatencyMs: avg, timeouts });
			await upsertSourceHealth(db, {
				source_id: s.id,
				success_rate: successRate,
				avg_latency_ms: avg,
				score,
				updated_at: now,
			});
			return s.id;
		}),
	);
	const checked = results.filter((r) => r.status === "fulfilled").length;
	return NextResponse.json({ code: 200, checked });
}
