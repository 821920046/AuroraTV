import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getPlayStats, getSourceHealthMap } from "@/lib/db";
import { getEnabledSources } from "@/lib/sources";
import { checkRateLimit, rateLimitedResponse } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const rl = await checkRateLimit(req);
	if (rl.limited) return rateLimitedResponse(rl);

	const { env } = getCloudflareContext();
	const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : {};
	// 真实播放成败。这是「这个源到底能不能看」唯一的一手证据，
	// 接口延迟再好看也替代不了 —— 一并暴露给后台和诊断面板。
	const play = env.AURORA_DB ? await getPlayStats(env.AURORA_DB, 7) : {};
	const sources = await getEnabledSources(env.AURORA_DB);
	const out = sources.map((s) => ({
		id: s.id,
		name: s.name,
		score: health[s.id]?.score ?? s.weight ?? 0,
		success_rate: health[s.id]?.success_rate ?? null,
		avg_latency_ms: health[s.id]?.avg_latency_ms ?? null,
		cors: health[s.id]?.cors ?? null,
		/** 最近 7 天播放成功率 0..1；null = 没有样本 */
		play_rate: play[s.id]?.rate ?? null,
		/** 样本量：太少时 play_rate 不可当真 */
		play_samples: play[s.id]?.samples ?? null,
	}));
	return NextResponse.json({ code: 200, sources: out });
}

// 客户端播放结果上报（成功/失败都记）。
// 变更：从 KV 改为 D1 聚合计数。
// 原因：KV 免费版每天只有 1000 次写，每次播放失败都写一条，很容易把配额烧光，
// 连带影响首页/搜索缓存写入；而且旧实现只记失败不记成功，无法算真实成功率。
export async function POST(req: NextRequest) {
	const rl = await checkRateLimit(req);
	if (rl.limited) return rateLimitedResponse(rl);

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
