import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getProxySecret, verifyToken } from "@/lib/proxy";
import { upstreamHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

// 海报 / 台标代理。
// 病因：采集站海报大量是 http 地址，https 页面上会被 Mixed Content 拦截，
// 表现为“满屏碎图”；部分 CDN 还有 Referer 防盗链。同样用签名代理解决。
const HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"timing-allow-origin": "*",
};

function err(status: number, msg: string): Response {
	return new Response(JSON.stringify({ code: status, msg }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...HEADERS },
	});
}

export async function GET(req: NextRequest): Promise<Response> {
	const target = req.nextUrl.searchParams.get("u");
	const token = req.nextUrl.searchParams.get("t");
	if (!target) return err(400, "missing u");

	const { env } = getCloudflareContext();
	const verdict = await verifyToken(getProxySecret(env), token, target);
	if (!verdict.ok) return err(403, "img proxy rejected: " + verdict.reason);

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			headers: upstreamHeaders(target, { accept: "image/avif,image/webp,image/*,*/*;q=0.8" }),
			redirect: "follow",
			// 海报是高重复、低变更内容，交给 Cloudflare 边缘缓存 1 天，几乎不增加回源
			cf: { cacheEverything: true, cacheTtl: 86400 },
		} as RequestInit);
	} catch {
		return err(502, "image upstream unreachable");
	}
	if (!upstream.ok) return err(upstream.status === 404 ? 404 : 502, "image " + upstream.status);

	const ct = upstream.headers.get("content-type") ?? "";
	if (!/^image\//i.test(ct)) return err(415, "not an image");

	const out = new Headers(HEADERS);
	out.set("content-type", ct);
	const len = upstream.headers.get("content-length");
	if (len) out.set("content-length", len);
	out.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
	return new Response(upstream.body, { status: 200, headers: out });
}
