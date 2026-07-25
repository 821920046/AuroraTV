import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	TokenMinter,
	getProxySecret,
	isLivePlaylist,
	looksLikePlaylistType,
	looksLikePlaylistUrl,
	rewritePlaylist,
	verifyToken,
} from "@/lib/proxy";
import { upstreamHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

// ============================================================================
// 同源流代理（本次升级的核心）
// ----------------------------------------------------------------------------
// GET /api/stream?u=<上游地址>&t=<签名>
//  - m3u8 ：拉回文本，把内部所有地址（子列表 / 分片 / AES 密钥 / init 段）改写为同源代理地址
//  - 分片/mp4：流式透传（不落盘、不缓冲），完整支持 Range，因此可拖动进度条
// 所有响应都带 CORS 头，且均为 https 同源 → 同时解决 Mixed Content 与 CORS 两大拦截。
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,HEAD,OPTIONS",
	"access-control-allow-headers": "Range,Content-Type,Accept",
	"access-control-expose-headers":
		"Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Aurora-Upstream",
	"timing-allow-origin": "*",
};

function err(status: number, msg: string): Response {
	return new Response(JSON.stringify({ code: status, msg }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
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

async function handle(req: NextRequest, method: "GET" | "HEAD"): Promise<Response> {
	const target = req.nextUrl.searchParams.get("u");
	const token = req.nextUrl.searchParams.get("t");
	if (!target) return err(400, "missing u");

	const { env } = getCloudflareContext();
	const secret = getProxySecret(env);
	const verdict = await verifyToken(secret, token, target);
	if (!verdict.ok) return err(403, "proxy rejected: " + verdict.reason);

	// 透传 Range，让浏览器能拖动进度、让 mp4 可分段拉取
	const range = req.headers.get("range");
	const headers = upstreamHeaders(target, range ? { range } : undefined);

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method,
			headers,
			redirect: "follow",
			// 不要让 Cloudflare 缓存分片：直播会卡帧，且很容易炸免费版缓存额度
			cf: { cacheEverything: false },
		} as RequestInit);
	} catch (e) {
		return err(502, "上游不可达: " + (e instanceof Error ? e.message : String(e)));
	}

	if (!upstream.ok && upstream.status !== 206) {
		return err(upstream.status === 404 ? 404 : 502, "上游返回 " + upstream.status);
	}

	const finalUrl = upstream.url || target;
	const ct = upstream.headers.get("content-type");
	const isPlaylist = looksLikePlaylistType(ct) || looksLikePlaylistUrl(finalUrl);

	// ---------- 分支 A：m3u8 播放列表 -> 改写 ----------
	if (isPlaylist && method === "GET") {
		let text: string;
		try {
			text = await upstream.text();
		} catch (e) {
			return err(502, "读取播放列表失败: " + (e instanceof Error ? e.message : String(e)));
		}
		if (!/#EXTM3U/i.test(text)) {
			// 不是真的播放列表（常见于被防盗链页面 / 验证页接管）
			return err(502, "上游返回的不是有效的 m3u8（可能被防盗链或地区限制拦截）");
		}
		const minter = new TokenMinter(secret);
		const rewritten = await rewritePlaylist(text, finalUrl, minter);
		const live = isLivePlaylist(text);
		return new Response(rewritten, {
			status: 200,
			headers: {
				"content-type": "application/vnd.apple.mpegurl; charset=utf-8",
				// 直播列表必须不缓存，否则画面会停在旧分片窗口
				"cache-control": live ? "no-store" : "public, max-age=30",
				"x-aurora-upstream": new URL(finalUrl).host,
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
	// ts/m4s 分片内容不变，可以让浏览器本地缓存，降低重复回源
	const cacheable = /\.(ts|m4s|mp4|aac|key)($|[?#])/i.test(finalUrl);
	out.set("cache-control", cacheable ? "public, max-age=600" : "no-store");
	out.set("x-aurora-upstream", new URL(finalUrl).host);

	return new Response(method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		headers: out,
	});
}
