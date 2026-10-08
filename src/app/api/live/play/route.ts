import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getChannel } from "@/lib/live";
import { TokenMinter } from "@/lib/proxy";
import { resolveProxySecret } from "@/lib/secret";

export const dynamic = "force-dynamic";

// 直播源几乎全部是 http + 无 CORS，https 页面下无一例外地被浏览器拦截。
// 因此同样返回双地址，并默认建议走同源代理。
export async function GET(req: NextRequest) {
	const id = req.nextUrl.searchParams.get("id");
	if (!id) return NextResponse.json({ code: 400, msg: "missing id" }, { status: 200 });

	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return NextResponse.json({ code: 503, msg: "未配置 D1 数据库" }, { status: 200 });

	const ch = await getChannel(env.AURORA_DB, id);
	if (!ch) return NextResponse.json({ code: 404, msg: "频道不存在" }, { status: 200 });

	const { secret } = await resolveProxySecret(env);
	const minter = new TokenMinter(secret);
	return NextResponse.json({
		code: 200,
		url: ch.stream_url,
		proxy: await minter.streamUrl(ch.stream_url),
		prefer: "proxy",
		name: ch.name,
		epg_id: ch.epg_id ?? null,
		flags: ch.flags,
	});
}
