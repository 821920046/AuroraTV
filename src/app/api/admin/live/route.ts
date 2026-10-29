import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	getLiveSources,
	upsertLiveSource,
	setLiveSourceEnabled,
	deleteLiveSource,
	getEnabledLiveSources,
	ingestChannels,
	getChannelCount,
	clearChannels,
	pruneChannels,
	slugify,
	RECOMMENDED_CN_SOURCES,
	type LiveSource,
} from "@/lib/live";

export const dynamic = "force-dynamic";

function noDb() {
	return NextResponse.json({ code: 500, msg: "AURORA_DB 未绑定，无法管理直播源" }, { status: 500 });
}

export async function GET() {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const sources = await getLiveSources(env.AURORA_DB);
	const channelCount = await getChannelCount(env.AURORA_DB);
	/*
	 * 一并返回推荐源，让后台能「逐个添加」而不是「一键全加」。
	 *
	 * 为什么不给一键按钮：RECOMMENDED_CN_SOURCES 里除了 iptv-org（各国广播机构
	 * 主动公开的直播流），还有几个民间聚合源 —— 它们可能夹带未授权转播。
	 * 全加进去等于替站长做了「要不要接这些」的决定，那不该由代码替他做。
	 * 逐个列出、各自一个按钮，加不加、加哪几个由人决定。
	 *
	 * keepAll 是服务端摄取时的地区过滤开关，前端用不到，不外传。
	 */
	const recommended = RECOMMENDED_CN_SOURCES.map((s) => ({
		id: s.id,
		name: s.name,
		url: s.url,
	}));
	return NextResponse.json({ code: 200, sources, channelCount, recommended });
}

// POST 分两种：添加订阅源 {name,url}；或立即摄取 {action:"ingest"}
export async function POST(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const body = (await req.json().catch(() => ({}))) as {
		action?: string;
		id?: string;
		name?: string;
		url?: string;
	};

	if (body.action === "ingest") {
		const sources = await getEnabledLiveSources(env.AURORA_DB);
		const result = await ingestChannels(env.AURORA_DB, sources);
		return NextResponse.json({ code: 200, ...result });
	}

	// 只保留白名单地区（国内/香港），删除其余已入库频道
	if (body.action === "prune") {
		const deleted = await pruneChannels(env.AURORA_DB);
		const channelCount = await getChannelCount(env.AURORA_DB);
		return NextResponse.json({ code: 200, deleted, channelCount });
	}

	// 一键写入推荐国内源（已存在则按 id 覆盖更新）
	if (body.action === "add_recommended") {
		for (const s of RECOMMENDED_CN_SOURCES) {
			await upsertLiveSource(env.AURORA_DB, { ...s, enabled: true });
		}
		const sources = await getLiveSources(env.AURORA_DB);
		return NextResponse.json({ code: 200, added: RECOMMENDED_CN_SOURCES.length, sources });
	}

	if (!body.name || !body.url)
		return NextResponse.json({ code: 400, msg: "name 和 url 为必填" }, { status: 400 });
	// 允许显式传 id：推荐源用它自己的固定 id（如 cn_iptv_org），
	// 这样「已添加」的判断和 add_recommended 写进去的是同一条记录，
	// 不会出现「点了一次添加，列表里却多出一条名字相似的重复项」。
	const src: LiveSource = {
		id: body.id ? String(body.id) : slugify(String(body.name)),
		name: String(body.name),
		url: String(body.url),
		enabled: true,
	};
	await upsertLiveSource(env.AURORA_DB, src);
	return NextResponse.json({ code: 200, id: src.id });
}

export async function PATCH(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	const body = (await req.json().catch(() => ({}))) as { id?: string; enabled?: boolean };
	if (!body.id) return NextResponse.json({ code: 400, msg: "缺少 id" }, { status: 400 });
	await setLiveSourceEnabled(env.AURORA_DB, body.id, body.enabled !== false);
	return NextResponse.json({ code: 200 });
}

export async function DELETE(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return noDb();
	// ?channels=1 清空已摄取频道；否则按 ?id= 删除订阅源
	if (req.nextUrl.searchParams.get("channels") === "1") {
		const deleted = await clearChannels(env.AURORA_DB);
		return NextResponse.json({ code: 200, deleted });
	}
	const id = req.nextUrl.searchParams.get("id");
	if (!id) return NextResponse.json({ code: 400, msg: "缺少 id" }, { status: 400 });
	await deleteLiveSource(env.AURORA_DB, id);
	return NextResponse.json({ code: 200 });
}
