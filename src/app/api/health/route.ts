import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { describeSecret, resolveProxySecret } from "@/lib/secret";
import { RATE_RULES } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

// ============================================================================
// 部署自检
// ----------------------------------------------------------------------------
// 【为什么需要这个接口】
// 代理签名密钥有三种来源，其中一种是「公开兜底常量」——
// 处于该状态时 /api/stream 与 /api/img 等于没有任何鉴权（它们在 middleware 里
// 被排除在 Basic Auth 之外，HMAC 是唯一防线）。这种事必须能被部署者一眼看到。
// 旧代码只是在 proxy.ts 的注释里写了句「会在 /api/health 提示」，
// 而那个路由压根不存在 —— 等于承诺了一个不存在的功能。
//
// 注意：**只返回状态，绝不回显密钥本身**。
// ============================================================================

/**
 * Cache API 是否真的可用 —— 不可用时限流会静默放行，这是必须能被看见的状态。
 * `caches.default` 是 Cloudflare 专有扩展，标准 CacheStorage 类型里没有它，
 * 且未定义的全局变量会直接抛 ReferenceError，所以整体包在 try 里。
 */
function cacheApiAvailable(): boolean {
	try {
		return Boolean((caches as unknown as { default?: unknown })?.default);
	} catch {
		return false;
	}
}

export async function GET() {
	const { env } = getCloudflareContext();
	const secret = describeSecret(await resolveProxySecret(env));
	return NextResponse.json({
		ok: true,
		// { source: "env" | "d1" | "fallback", weak: boolean }
		secret,
		db: Boolean(env.AURORA_DB),
		kv: Boolean(env.AURORA_KV),
		auth: Boolean(env.USERNAME && env.PASSWORD),
		// 限流：把全部规则列出来，便于核对「哪个端点没被限流」。
		rate_limit: {
			storage: cacheApiAvailable() ? "cache-api" : "none",
			rules: RATE_RULES,
			// 这一层的定位必须写清楚，否则很容易被误当成精确配额。
			note: "应用层兜底：Cache API 固定窗口近似计数（按 colo 独立、读改写有竞态，偏宽松）。精确边缘限流请在 Cloudflare 控制台配 Rate Limiting Rules。",
		},
		// DNS 预解析：纵深防御。DoH 不可用时 fail-open，这个取舍要显式暴露出来。
		dns_guard: {
			mode: "doh",
			fail_mode: "open",
			note: "在 isSafeUpstream 静态校验之外，再解析一次域名，防 DNS rebinding。DoH 查询失败时放行并打日志。",
		},
		ts: Date.now(),
	});
}
