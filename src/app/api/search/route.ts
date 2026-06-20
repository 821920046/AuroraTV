import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { aggregateSearch } from "@/lib/aggregator";
import { cacheGetWithKv, cacheSetWithKv, makeCacheKey } from "@/lib/cache";
import { getSourceHealthMap } from "@/lib/db";
import { getEnabledSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kw = req.nextUrl.searchParams.get("wd")?.trim();
  if (!kw) return NextResponse.json({ code: 400, msg: "missing wd" }, { status: 400 });

  try {
    const { env } = getCloudflareContext();
    const key = makeCacheKey("search", kw);

    const cached = await cacheGetWithKv<unknown[]>(key, env);
    if (cached) return NextResponse.json({ code: 200, cached: true, list: cached });

    const sources = await getEnabledSources(env.AURORA_DB);
    const health = env.AURORA_DB ? await getSourceHealthMap(env.AURORA_DB) : undefined;
    const list = await aggregateSearch(kw, sources, health);

    // 搜索结果变更较快，不写 KV，仅走边缘缓存
    await cacheSetWithKv(key, list, env, 60 * 60 * 6, false);
    return NextResponse.json({ code: 200, cached: false, list });
  } catch (e) {
    // 任何异常都降级为空结果，避免前端拿到 500；错误信息随响应返回以便排查
    console.error("search route failed:", e);
    return NextResponse.json(
      { code: 200, cached: false, list: [], error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
