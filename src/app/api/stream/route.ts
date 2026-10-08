import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	TokenMinter,
	guardedFetch,
	isLivePlaylist,
	looksLikePlaylistType,
	looksLikePlaylistUrl,
	rewritePlaylist,
	verifyToken,
} from "@/lib/proxy";
import { resolveProxySecret } from "@/lib/secret";
import { HEADER_LADDER, upstreamHeaders, type HeaderVariant } from "@/lib/http";

export const dynamic = "force-dynamic";

// ============================================================================
// 同源流代理（本次升级的核心）
// ----------------------------------------------------------------------------
// GET /api/stream?u=<上游地址>&t=<签名>[&debug=1]
//  - m3u8 ：拉回文本，把内部所有地址（子列表 / 分片 / AES 密钥 / init 段）改写为同源代理地址
//  - 分片/mp4：流式透传，完整支持 Range
//
// 【为什么有请求头降级梯子】
// 防盗链不是单一规则：有的源要求 Referer 同站，有的源反而拒绝带 Referer 的请求（当作盗链源站），
// 还有的只放行移动端 UA。单一策略必然在部分源上 403。因此遇 401/403/406/429 时换一套头重试。
//
// 【为什么错误要写进响应头】
// 浏览器控制台只能看到「502」三个字，看不到 body，无法定位。
// 所以把真实原因同时放到 x-aurora-reason 响应头（Network 面板直接可见）。
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,HEAD,OPTIONS",
	"access-control-allow-headers": "Range,Content-Type,Accept",
	"access-control-expose-headers":
		"Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Aurora-Upstream,X-Aurora-Reason,X-Aurora-Variant",
	"timing-allow-origin": "*",
};

function err(status: number, msg: string, extra?: Record<string, string>): Response {
	return new Response(JSON.stringify({ code: status, msg, ...extra }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// 控制台只显示状态码，原因放头里才看得到
			"x-aurora-reason": encodeURIComponent(msg).slice(0, 300),
			...CORS_HEADERS,
			...(extra ?? {}),
		},
	});
}

export async function OPTIONS(): Promise<Response> {
	return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "max-age": "86400" } });
}

export async function HEAD(req: NextRequest): Promise<Response> {
	return handle(req, "HEAD");
}

export async function GET(req: NextRequest): Promise<Response> {
	return handle(req, "GET");
}

type Attempt = { variant: HeaderVariant; status: number | string };

async function handle(req: NextRequest, method: "GET" | "HEAD"): Promise<Response> {
	const target = req.nextUrl.searchParams.get("u");
	const token = req.nextUrl.searchParams.get("t");
	const debug = req.nextUrl.searchParams.get("debug") === "1";
	if (!target) return err(400, "missing u");

	const { env } = getCloudflareContext();
	const { secret } = await resolveProxySecret(env);
	const verdict = await verifyToken(secret, token, target);
	if (!verdict.ok) return err(403, "proxy rejected: " + verdict.reason);

	const range = req.headers.get("range");
	const attempts: Attempt[] = [];
	let upstream: Response | null = null;
	let usedVariant: HeaderVariant = "browser";
	let finalUrl = target;

	// ---------- 请求头降级梯子 ----------
	for (const variant of HEADER_LADDER) {
		try {
			const got = await guardedFetch(target, {
				method,
				// Referer 必须按「当前这一跳」的域名生成，跳转后仍带旧域名的 Referer 会被拒。
				headers: (u) => upstreamHeaders(u, range ? { range } : undefined, variant),
				cf: { cacheEverything: false },
			});
			if (!got.ok) {
				attempts.push({ variant, status: got.error });
				continue;
			}
			const { res } = got;
			attempts.push({ variant, status: res.status });
			if (res.ok || res.status === 206) {
				upstream = res;
				usedVariant = variant;
				finalUrl = got.finalUrl;
				break;
			}
			// 只有「看起来像被风控」的状态才值得换头重试；404/410 是确定性失败，直接放弃
			if (![401, 403, 405, 406, 429].includes(res.status) && res.status < 500) {
				upstream = res;
				usedVariant = variant;
				finalUrl = got.finalUrl;
				break;
			}
			// 丢弃本次 body，避免 Workers 警告未读取的响应体
			try {
				await res.body?.cancel();
			} catch {
				/* ignore */
			}
		} catch (e) {
			attempts.push({ variant, status: e instanceof Error ? e.message : String(e) });
		}
	}

	const trace = attempts.map((a) => a.variant + "=" + a.status).join(", ");

	if (!upstream) {
		return err(502, "上游不可达或全部策略被拒：" + trace, { "x-aurora-trace": trace });
	}
	if (!upstream.ok && upstream.status !== 206) {
		try {
			await upstream.body?.cancel();
		} catch {
			/* ignore */
		}
		return err(
			upstream.status === 404 || upstream.status === 410 ? 404 : 502,
			"上游返回 " + upstream.status + "（" + trace + "）",
			{ "x-aurora-trace": trace },
		);
	}

	const ct = upstream.headers.get("content-type");
	const isPlaylist = looksLikePlaylistType(ct) || looksLikePlaylistUrl(finalUrl);

	if (debug) {
		return new Response(
			JSON.stringify(
				{
					ok: true,
					target,
					finalUrl,
					status: upstream.status,
					contentType: ct,
					isPlaylist,
					usedVariant,
					attempts,
				},
				null,
				2,
			),
			{ headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS } },
		);
	}

	// ---------- 分支 A：m3u8 播放列表 -> 改写 ----------
	if (isPlaylist && method === "GET") {
		let text: string;
		try {
			text = await upstream.text();
		} catch (e) {
			return err(502, "读取播放列表失败: " + (e instanceof Error ? e.message : String(e)));
		}
		if (!/#EXTM3U/i.test(text)) {
			return err(
				502,
				"上游返回的不是有效 m3u8（可能被防盗链/验证页/地区限制拦截）。首 120 字符：" +
					text.slice(0, 120).replace(/\s+/g, " "),
			);
		}
		const minter = new TokenMinter(secret);
		const rewritten = await rewritePlaylist(text, finalUrl, minter);
		const live = isLivePlaylist(text);
		return new Response(rewritten, {
			status: 200,
			headers: {
				"content-type": "application/vnd.apple.mpegurl; charset=utf-8",
				"cache-control": live ? "no-store" : "public, max-age=30",
				"x-aurora-upstream": new URL(finalUrl).host,
				"x-aurora-variant": usedVariant,
				...CORS_HEADERS,
			},
		});
	}

	// ---------- 分支 B：分片 / mp4 / 密钥 -> 流式透传 ----------
	const out = new Headers(CORS_HEADERS);
	const passthrough = [
		"content-type",
		"content-length",
		"content-range",
		"accept-ranges",
		"last-modified",
		"etag",
	];
	for (const h of passthrough) {
		const v = upstream.headers.get(h);
		if (v) out.set(h, v);
	}
	if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
	const cacheable = /\.(ts|m4s|mp4|aac|key)($|[?#])/i.test(finalUrl);
	out.set("cache-control", cacheable ? "public, max-age=600" : "no-store");
	out.set("x-aurora-upstream", new URL(finalUrl).host);
	out.set("x-aurora-variant", usedVariant);

	return new Response(method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		headers: out,
	});
}
