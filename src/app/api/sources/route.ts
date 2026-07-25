import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSourceHealthMap } from "@/lib/db";
import { getEnabledSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function GET() {
	const { env } = getCloudflareContext();
	const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : {};
	const sources = await getEnabledSources(env.AURORA_DB);
	const out = sources.map((s) => ({
		id: s.id,
		name: s.name,
		score: health[s.id]?.score ?? s.weight ?? 0,
		success_rate: health[s.id]?.success_rate ?? null,
		avg_latency_ms: health[s.id]?.avg_latency_ms ?? null,
		cors: health[s.id]?.cors ?? null,
	}));
	return NextResponse.json({ code: 200, sources: out });
}

// 客户端播放结果上报（成功/失败都记）。
// 变更：从 KV 改为 D1 聚合计数。
// 原因：KV 免费版每天只有 1000 次写，每次播放失败都写一条，很容易把配额烧光，
// 连带影响首页/搜索缓存写入；而且旧实现只记失败不记成功，无法算真实成功率。
export async function POST(req: NextRequest) {
	const { env } = getCloudflareContext();
	const body = (await req.json().catch(() => ({}))) as {
		source_id?: string;
		ok?: boolean;
		mode?: string;
	};
	const id = (body.source_id ?? "").slice(0, 64);
	if (!id || !env.AURORA_DB) return NextResponse.json({ code: 200 });

	const day = new Date().toISOString().slice(0, 10);
	const ok = body.ok ? 1 : 0;
	const fail = body.ok ? 0 : 1;
	try {
		await env.AURORA_DB.prepare(
			`INSERT INTO play_stat (source_id, day, ok, fail, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(source_id, day) DO UPDATE SET
			   ok = ok + ?3, fail = fail + ?4, updated_at = ?5`,
		)
			.bind(id, day, ok, fail, Math.floor(Date.now() / 1000))
			.run();
	} catch (e) {
		// 迁移 0006 未执行时静默降级，上报失败绝不能影响播放
		console.error("play_stat upsert failed:", e);
	}
	return NextResponse.json({ code: 200 });
}
