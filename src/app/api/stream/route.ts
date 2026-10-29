import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	TokenMinter,
	guardedFetch,
	hostOf,
	isLivePlaylist,
	looksLikePlaylistType,
	looksLikePlaylistUrl,
	rewritePlaylist,
	verifyToken,
} from "@/lib/proxy";
import { resolveProxySecret } from "@/lib/secret";
import { checkRateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { ladderWith, upstreamHeaders, type HeaderVariant } from "@/lib/http";

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
		"Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Aurora-Upstream,X-Aurora-Reason,X-Aurora-Variant,Server-Timing",
	"timing-allow-origin": "*",
};

/**
 * 哪些上游地址值得进 Cloudflare 边缘缓存：只有 HLS 分片。
 *
 * 【为什么之前等于没缓存】
 * 这里原本对**所有**请求都写 `cf: { cacheEverything: false }`，而 `/api/stream`
 * 这个路径没有文件扩展名，本来就不在 Cloudflare 的默认缓存名单里 ——
 * 两者叠加的后果是**每个分片都要完整跑一次 Worker 再回源一次上游**。
 * 一集 45 分钟的剧约 450 个分片，就是这么硬扛下来的；
 * 手机上观感就是「一直缓冲、一直加载」。
 *
 * 【为什么只放分片，不放 mp4】
 * mp4 是单个大对象，Range 请求会把缓存打得很碎，命中率低；
 * 分片则是 6~10 秒一小块，同一部剧的所有观众拉的是同样的 URL，
 * 命中率极高。收益大、风险小。
 *
 * 【为什么清单（m3u8）不缓存上游】
 * 清单由 rewritePlaylist 现算，响应头也只给 max-age=30；
 * 直播清单更是每次都必须回源。缓存上游纯属浪费。
 */
const EDGE_CACHEABLE_SEGMENT = /\.(ts|m4s|aac|key)($|[?#])/i;
const SEGMENT_EDGE_TTL = 600;

/**
 * 按 host 记住「上次成功的请求头策略」。
 *
 * 【为什么这是必需而不是优化】
 * HEADER_LADDER 从 "browser" 开始逐档降级。如果某个源站只放行 "noreferer"
 * 或 "mobile"，那么【每一个分片】都要先被 403 一次，才轮到能用的那一档 ——
 * 而分片请求是 HLS 播放的最热路径：一集 45 分钟的剧约 450 个分片。
 * 450 × 1 次多余的往返（哪怕只有 300ms）就是 2 分多钟纯浪费，
 * 手机上的观感正是「一直转圈、偶尔动一下」。
 *
 * 记住之后，同一 host 的分片第一次就用对的那一档，零重试。
 * 记忆只在 isolate 内存里，随冷启动自然失效 —— 源站换了规则也不会永久卡住：
 * 记住的那档一旦失败，梯子会继续往下走，成功后再覆盖记忆。
 *
 * 容量保护：正常部署的 host 数量是几十，超过上限整体清空重来，
 * 避免被「每次请求换一个随机域名」的流量把内存撑爆。
 */
const variantMemo = new Map<string, HeaderVariant>();
const VARIANT_MEMO_MAX = 200;

/** 把记住的档位提到最前面，其余保持原顺序。规则本身在 http.ts 里，可单测。 */
function ladderFor(host: string): HeaderVariant[] {
	return ladderWith(variantMemo.get(host));
}

/** 记录成功的档位。只在变化时写，避免热路径上反复 set。 */
function rememberVariant(host: string, variant: HeaderVariant): void {
	if (!host || variantMemo.get(host) === variant) return;
	if (variantMemo.size >= VARIANT_MEMO_MAX) variantMemo.clear();
	variantMemo.set(host, variant);
}

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
	const t0 = Date.now();
	const target = req.nextUrl.searchParams.get("u");
	const token = req.nextUrl.searchParams.get("t");
	const debug = req.nextUrl.searchParams.get("debug") === "1";
	if (!target) return err(400, "missing u");

	const { env } = getCloudflareContext();
	const { secret } = await resolveProxySecret(env);
	const verdict = await verifyToken(secret, token, target);
	if (!verdict.ok) return err(403, "proxy rejected: " + verdict.reason);

	// 限流放在签名校验【之后】：无效令牌在上一行就被 403 挡掉了，消耗可忽略；
	// 这里要约束的是「合法但过量」的流量，也就是真正会打到上游、烧 Worker CPU 的那部分。
	// 额度按分片粒度定（见 lib/ratelimit.ts 的 RATE_RULES.stream），不是按「操作次数」。
	const rl = await checkRateLimit(req);
	if (rl.limited) return rateLimitedResponse(rl, CORS_HEADERS);

	const range = req.headers.get("range");
	const attempts: Attempt[] = [];
	let upstream: Response | null = null;
	let usedVariant: HeaderVariant = "browser";
	let finalUrl = target;
	// 分片才走边缘缓存，理由见 EDGE_CACHEABLE_SEGMENT 上面的长注释。
	const edgeCache = EDGE_CACHEABLE_SEGMENT.test(target);
	const upstreamCf = edgeCache
		? { cacheEverything: true, cacheTtl: SEGMENT_EDGE_TTL }
		: { cacheEverything: false };

	// ---------- 请求头降级梯子 ----------
	// 上次成功的档位提到最前，避免每个分片都从 "browser" 重新试一遍。
	const targetHost = hostOf(target);
	const ladder = ladderFor(targetHost);
	const tFetch = Date.now();
	for (const variant of ladder) {
		try {
			const got = await guardedFetch(target, {
				method,
				// Referer 必须按「当前这一跳」的域名生成，跳转后仍带旧域名的 Referer 会被拒。
				headers: (u) => upstreamHeaders(u, range ? { range } : undefined, variant),
				cf: upstreamCf,
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
				// 只有真正成功才值得记 —— 404 只说明资源不存在，与请求头无关
				rememberVariant(targetHost, variant);
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
	// 回源总耗时（含降级梯子上所有重试）。与 /api/img 同一个口径，
	// 供页面内诊断面板把 TTFB 拆成「上游」和「Worker 自身」两段。
	const upstreamMs = Date.now() - tFetch;
	const timing =
		"upstream;dur=" + upstreamMs + ", worker;dur=" + Math.max(0, Date.now() - t0 - upstreamMs);

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
				"server-timing": timing,
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
	// 注意这里的判断比上面的 EDGE_CACHEABLE_SEGMENT 宽（多了 mp4）—— 两者不是漏改：
	// 这一行管的是**浏览器**缓存（mp4 的 Range 请求由浏览器自己消化，缓存它有益），
	// EDGE_CACHEABLE_SEGMENT 管的是 **Cloudflare 边缘**缓存（mp4 单个大对象会把缓存打碎）。
	const cacheable = /\.(ts|m4s|mp4|aac|key)($|[?#])/i.test(finalUrl);
	out.set("cache-control", cacheable ? "public, max-age=600" : "no-store");
	out.set("x-aurora-upstream", new URL(finalUrl).host);
	out.set("x-aurora-variant", usedVariant);
	out.set("server-timing", timing);

	return new Response(method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		headers: out,
	});
}
