import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { describeSecret, resolveProxySecret } from "@/lib/secret";

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
		ts: Date.now(),
	});
}
