import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { guardedFetch, verifyToken } from "@/lib/proxy";
import { resolveProxySecret } from "@/lib/secret";
import { upstreamHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

// ============================================================================
// 海报 / 台标代理
// ----------------------------------------------------------------------------
// 病因：采集站海报大量是 http 地址，https 页面上会被 Mixed Content 拦截，
// 表现为「满屏碎图」；部分 CDN 还有 Referer 防盗链。同样用签名代理解决。
//
// 【为什么这里也要逐跳校验重定向】
// 上一轮修好 /api/stream 的 SSRF 重定向绕过时漏了本文件：签名只绑定「发起请求的
// 那个 URL」，只要用 `redirect: "follow"`，一个通过校验的公网图床就能 302 到
// `http://169.254.169.254/…`。两处现在共用 guardedFetch，不会再各修各的。
//
// 【为什么要限体积】
// 海报 URL 来自第三方采集接口的 `vod_pic` 字段。若上游被投毒或返回超大的伪图片，
// 旧实现会把整个响应体原样回传（并写进边缘缓存），等于给攻击者一个免费 CDN。
// ============================================================================

/** 单张图片最大 8MB —— 正常海报 100KB 级，留足余量 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"timing-allow-origin": "*",
};

function err(status: number, msg: string): Response {
	return new Response(JSON.stringify({ code: status, msg }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// 与 /api/stream 一致：控制台只显示状态码，原因放头里才看得到
			"x-aurora-reason": encodeURIComponent(msg).slice(0, 300),
			...HEADERS,
		},
	});
}

/**
 * 给响应体套一个字节上限。
 * 仅靠 content-length 预检不够 —— 分块传输（chunked）根本不带该头，
 * 必须在上传过程中兜底，否则照样能把整个大文件拉完。
 */
function capBytes(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
	let seen = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > max) {
					controller.error(new Error(`image exceeds ${max} bytes`));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

export async function GET(req: NextRequest): Promise<Response> {
	return handle(req, "GET");
}

export async function HEAD(req: NextRequest): Promise<Response> {
	return handle(req, "HEAD");
}

async function handle(req: NextRequest, method: "GET" | "HEAD"): Promise<Response> {
	const target = req.nextUrl.searchParams.get("u");
	const token = req.nextUrl.searchParams.get("t");
	if (!target) return err(400, "missing u");

	const { env } = getCloudflareContext();
	const { secret } = await resolveProxySecret(env);
	const verdict = await verifyToken(secret, token, target);
	if (!verdict.ok) return err(403, "img proxy rejected: " + verdict.reason);

	const got = await guardedFetch(target, {
		method,
		headers: (u) => upstreamHeaders(u, { accept: "image/avif,image/webp,image/*,*/*;q=0.8" }),
		// 海报是高重复、低变更内容，交给 Cloudflare 边缘缓存 1 天，几乎不增加回源
		cf: { cacheEverything: true, cacheTtl: 86400 },
	});
	if (!got.ok) return err(502, "image " + got.error);
	const upstream = got.res;
	if (!upstream.ok) return err(upstream.status === 404 ? 404 : 502, "image " + upstream.status);

	const ct = upstream.headers.get("content-type") ?? "";
	if (!/^image\//i.test(ct)) {
		try {
			await upstream.body?.cancel();
		} catch {
			/* ignore */
		}
		return err(415, "not an image");
	}

	// 预检：带 content-length 且超限时直接拒绝，连流都不用开。
	// 注意不能写成 Number.isFinite(declared) && declared > MAX —— 伪造 "1e999" 会得到
	// Infinity，被 isFinite 判为「非法」从而跳过预检。NaN（非数字头）自然不满足 > 比较。
	const rawLen = upstream.headers.get("content-length");
	if (rawLen !== null && Number(rawLen) > MAX_IMAGE_BYTES) {
		try {
			await upstream.body?.cancel();
		} catch {
			/* ignore */
		}
		return err(413, "image too large: " + rawLen + " bytes");
	}

	const out = new Headers(HEADERS);
	out.set("content-type", ct);
	// 刻意【不透传 content-length】：Workers 的 fetch 会自动解压 gzip/br 并移除
	// content-encoding，但 content-length 仍是压缩前的长度。原样回传会让浏览器按
	// 旧长度截断图片（表现为「图裂了一半」），而分块传输没有任何副作用。
	out.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");

	if (method === "HEAD" || !upstream.body) return new Response(null, { status: 200, headers: out });
	return new Response(capBytes(upstream.body, MAX_IMAGE_BYTES), { status: 200, headers: out });
}
