import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getChannels, getChannelGroups, getChannelsVersion } from "@/lib/live";
import { cacheGet, cacheSet, makeCacheKey } from "@/lib/cache";
import { TokenMinter, getProxySecret } from "@/lib/proxy";

export const dynamic = "force-dynamic";

// 返回直播频道列表 + 分组。走 Cache API（边缘缓存，不烧 KV 写额度）。
// 变更：台标（多为 http）走同源图片代理，否则 https 页面下全部被混合内容拦截成碎图。
type ChannelRow = { logo?: string | null; [k: string]: unknown };

export async function GET(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return NextResponse.json({ code: 200, channels: [], groups: [] });
	const group = req.nextUrl.searchParams.get("group")?.trim() || undefined;
	const fresh = req.nextUrl.searchParams.get("fresh") === "1";

	try {
		const ver = await getChannelsVersion(env.AURORA_DB);
		const key = makeCacheKey("live_channels", (group ?? "all") + ":v2:" + ver);

		if (!fresh) {
			const cached = await cacheGet<{ channels: unknown[]; groups: unknown[] }>(key);
			if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });
		}

		const [rawChannels, groups] = await Promise.all([
			getChannels(env.AURORA_DB, { group, limit: group ? 600 : 1500 }),
			getChannelGroups(env.AURORA_DB),
		]);

		const minter = new TokenMinter(getProxySecret(env));
		const channels = await Promise.all(
			(rawChannels as ChannelRow[]).map(async (c) => ({
				...c,
				logo: c.logo ? await minter.imageUrl(String(c.logo)) : null,
			})),
		);

		await cacheSet(key, { channels, groups }, 60 * 30);
		return NextResponse.json({ code: 200, cached: false, channels, groups });
	} catch (e) {
		console.error("live channels route failed:", e);
		return NextResponse.json({ code: 200, channels: [], groups: [], error: String(e) });
	}
}
