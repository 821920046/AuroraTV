import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSourceHealthMap } from "@/lib/db";
import { enabledSources } from "@/lib/sources";

export async function GET() {
	const { env } = getCloudflareContext();
	const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : {};
	const sources = enabledSources().map((s) => ({
		id: s.id,
		name: s.name,
		score: health[s.id]?.score ?? s.weight ?? 0,
		success_rate: health[s.id]?.success_rate ?? null,
		avg_latency_ms: health[s.id]?.avg_latency_ms ?? null,
	}));
	return NextResponse.json({ code: 200, sources });
}

// 客户端播放失败上报（用于动态降权，简单计数实现）
export async function POST(req: NextRequest) {
	const { env } = getCloudflareContext();
	const body = (await req.json().catch(() => ({}))) as { source_id?: string };
	if (body?.source_id && env.AURORA_KV) {
		const hour = new Date().toISOString().slice(0, 13);
		const k = `fail:${body.source_id}:${hour}`;
		const cur = Number((await env.AURORA_KV.get(k)) ?? "0") + 1;
		await env.AURORA_KV.put(k, String(cur), { expirationTtl: 60 * 60 * 24 });
	}
	return NextResponse.json({ code: 200 });
}
