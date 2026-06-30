import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	getAllSources,
	upsertSource,
	deleteSource,
	deleteAllSources,
	setSourceEnabled,
	makeSourceId,
	type VideoSource,
} from "@/lib/sources";
import { getSourceHealthMap, clearSourceAutoDisabled } from "@/lib/db";
import { runHealthCheck } from "@/lib/health";

export const dynamic = "force-dynamic";

function noDb() {
	return NextResponse.json({ code: 500, msg: "AURORA_DB 未绑定，无法管理片源" }, { status: 500 });
}

export async function GET() {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const sources = await getAllSources(env.AURORA_DB);
	const health = await getSourceHealthMap(env.AURORA_DB);
	return NextResponse.json({
		code: 200,
		sources: sources.map((s) => ({
			...s,
			score: health[s.id]?.score ?? null,
			success_rate: health[s.id]?.success_rate ?? null,
			avg_latency_ms: health[s.id]?.avg_latency_ms ?? null,
			auto_disabled: health[s.id]?.auto_disabled ?? 0,
			fail_streak: health[s.id]?.fail_streak ?? 0,
			last_ok_at: health[s.id]?.last_ok_at ?? null,
		})),
	});
}

export async function POST(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const body = (await req.json().catch(() => ({}))) as Partial<VideoSource> & {
		action?: string;
		limit?: number;
		probes?: number;
		streak?: number;
	};
	if (body.action === "health_check") {
		const result = await runHealthCheck(env.AURORA_DB, {
			limit: body.limit,
			probes: body.probes,
			streak: body.streak,
		});
		return NextResponse.json({ code: 200, ...result });
	}
	if (!body.name || !body.api)
		return NextResponse.json({ code: 400, msg: "name 和 api 为必填" }, { status: 400 });
	const id = body.id ? String(body.id) : makeSourceId(String(body.name), String(body.api));
	const src: VideoSource = {
		id,
		name: String(body.name),
		api: String(body.api),
		detail: body.detail ? String(body.detail) : undefined,
		weight: body.weight != null ? Number(body.weight) : 1,
		enabled: body.enabled !== false,
	};
	await upsertSource(env.AURORA_DB, src);
	return NextResponse.json({ code: 200, id });
}

export async function PATCH(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const body = (await req.json().catch(() => ({}))) as { id?: string; enabled?: boolean };
	if (!body.id) return NextResponse.json({ code: 400, msg: "缺少 id" }, { status: 400 });
	await setSourceEnabled(env.AURORA_DB, body.id, body.enabled !== false);
	if (body.enabled !== false) await clearSourceAutoDisabled(env.AURORA_DB, body.id);
	return NextResponse.json({ code: 200 });
}

export async function DELETE(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const all = req.nextUrl.searchParams.get("all");
	if (all === "1" || all === "true") {
		const deleted = await deleteAllSources(env.AURORA_DB);
		return NextResponse.json({ code: 200, deleted });
	}
	const id = req.nextUrl.searchParams.get("id");
	if (!id) return NextResponse.json({ code: 400, msg: "缺少 id" }, { status: 400 });
	await deleteSource(env.AURORA_DB, id);
	return NextResponse.json({ code: 200 });
}
