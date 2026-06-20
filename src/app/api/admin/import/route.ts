import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseSubscription, importSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

// 从订阅 URL 或粘贴的 JSON 文本批量导入片源。
export async function POST(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB)
		return NextResponse.json({ code: 500, msg: "AURORA_DB 未绑定" }, { status: 500 });

	const body = (await req.json().catch(() => ({}))) as {
		url?: string;
		text?: string;
		json?: unknown;
	};

	let data: unknown = body.json ?? null;

	if (!data && body.url) {
		try {
			const r = await fetch(body.url, { headers: { "user-agent": "AuroraTV/1.0" } });
			if (!r.ok)
				return NextResponse.json({ code: 502, msg: "订阅地址请求失败: " + r.status }, { status: 502 });
			data = await r.json();
		} catch {
			return NextResponse.json({ code: 502, msg: "订阅地址无法访问或返回的不是 JSON" }, { status: 502 });
		}
	}

	if (!data && body.text) {
		try {
			data = JSON.parse(body.text);
		} catch {
			return NextResponse.json({ code: 400, msg: "粘贴的内容不是合法 JSON" }, { status: 400 });
		}
	}

	if (!data) return NextResponse.json({ code: 400, msg: "请提供订阅 URL 或 JSON 文本" }, { status: 400 });

	const list = parseSubscription(data);
	if (list.length === 0)
		return NextResponse.json({ code: 422, msg: "未从订阅中解析到任何片源" }, { status: 422 });

	const imported = await importSources(env.AURORA_DB, list);
	return NextResponse.json({ code: 200, imported, names: list.map((s) => s.name).slice(0, 50) });
}
