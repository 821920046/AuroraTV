import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getChannels, getChannelGroups, getChannelsVersion } from "@/lib/live";
import { cacheGet, cacheSet, makeCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

// 返回直播频道列表 + 分组。走 Cache API（边缘缓存，不烧 KV 写额度）。
export async function GET(req: NextRequest) {
	const { env } = getCloudflareContext();
	if (!env.AURORA_DB) return NextResponse.json({ code: 200, channels: [], groups: [] });
	const group = req.nextUrl.searchParams.get("group")?.trim() || undefined;
	// fresh=1 跳过缓存（手动刷新时用）
	const fresh = req.nextUrl.searchParams.get("fresh") === "1";

	try {
		// 版本号随摄取/探活变化，纳入 key 后旧缓存自动失效
		const ver = await getChannelsVersion(env.AURORA_DB);
		const key = makeCacheKey("live_channels", (group ?? "all") + ":" + ver);

		if (!fresh) {
			const cached = await cacheGet<{ channels: unknown[]; groups: unknown[] }>(key);
			if (cached) return NextResponse.json({ code: 200, cached: true, ...cached });
		}

		const [channels, groups] = await Promise.all([
			getChannels(env.AURORA_DB, { group, limit: group ? 600 : 1500 }),
			getChannelGroups(env.AURORA_DB),
		]);
		await cacheSet(key, { channels, groups }, 60 * 30); // 30 分钟（版本号保证新鲜）
		return NextResponse.json({ code: 200, cached: false, channels, groups });
	} catch (e) {
		console.error("live channels route failed:", e);
		return NextResponse.json({ code: 200, channels: [], groups: [], error: String(e) });
	}
}
