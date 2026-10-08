import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	TokenMinter,
	getProxySecret,
	isLivePlaylist,
	isSafeUpstream,
	looksLikePlaylistType,
	looksLikePlaylistUrl,
	rewritePlaylist,
	verifyToken,
} from "@/lib/proxy";
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

/** 最多跟随多少跳重定向 */
const MAX_REDIRECTS = 3;

/**
 * 带 SSRF 防护的取流：手动跟随重定向，**每一跳都重新做地址校验**。
 *
 * 【为什么必须手动跟随】
 * 签名只绑定「发起请求的那个 URL」。若用 `redirect: "follow"`，一个通过校验的
 * 公网地址完全可以 302 到 `http://169.254.169.254/…`（云元数据）或
 * `http://127.0.0.1/…`，校验形同虚设 —— 这正是典型的 SSRF 重定向绕过。
 * 这里改为 `redirect: "manual"`，逐跳校验后再继续。
 */
async function fetchGuarded(
	target: string,
	method: "GET" | "HEAD",
	range: string | null,
	variant: HeaderVariant,
): Promise<{ res: Response; finalUrl: string } | { error: string }> {
	let url = target;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!isSafeUpstream(url)) {
			return { error: `blocked upstream after ${hop} redirect(s): ${hostOf(url)}` };
		}
		// Referer 必须按「当前这一跳」的域名生成，跳转后仍带旧域名的 Referer 会被拒。
		const headers = upstreamHeaders(url, range ? { range } : undefined, variant);
		const res = await fetch(url, {
			method,
			headers,
			redirect: "manual",
			cf: { cacheEverything: false },
		} as RequestInit);

		// 运行时差异兜底：Cloudflare Workers 的 `manual` 会返回真实 3xx（Location 可读），
		// 而浏览器语义会返回 opaqueredirect（status 0、响应头不可读）。
		// 万一落到后者，就退回 `follow`，但事后用 res.url 校验最终落点 —— 宁可
		// 校验得晚一点，也不能让重定向把 SSRF 防护整个绕过去。
		if (res.status === 0 || res.type === "opaqueredirect") {
			const followed = await fetch(url, {
				method,
				headers,
				redirect: "follow",
				cf: { cacheEverything: false },
			} as RequestInit);
			if (!isSafeUpstream(followed.url)) {
				try {
					await followed.body?.cancel();
				} catch {
					/* ignore */
				}
				return { error: `blocked redirect target: ${hostOf(followed.url)}` };
			}
			return { res: followed, finalUrl: followed.url };
		}

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			try {
				await res.body?.cancel();
			} catch {
				/* ignore */
			}
			if (!location) return { error: "redirect without location" };
			try {
				url = new URL(location, url).toString();
			} catch {
				return { error: "malformed redirect location" };
			}
			continue;
		}
		return { res, finalUrl: url };
	}
	return { error: `too many redirects (>${MAX_REDIRECTS})` };
}

function hostOf(raw: string): string {
	try {
		return new URL(raw).host;
	} catch {
		return "invalid-url";
	}
}

async function handle(req: NextRequest, method: "GET" | "HEAD"): Promise<Response> {
	const target = req.nextUrl.searchParams.get("u");
	const token = req.nextUrl.searchParams.get("t");
	const debug = req.nextUrl.searchParams.get("debug") === "1";
	if (!target) return err(400, "missing u");

	const { env } = getCloudflareContext();
	const secret = getProxySecret(env);
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
			const got = await fetchGuarded(target, method, range, variant);
			if ("error" in got) {
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
