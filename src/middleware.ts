import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
	CLIENT_ID_COOKIE,
	clientIdCookie,
	newClientId,
	readCookie,
} from "@/lib/ratelimit";

// 站长鉴权：HTTP Basic Auth 保护全站。
// 排除静态资源与三类自带鉴权的接口：
//   - /api/cron          ：用 CRON_SECRET 鉴权
//   - /api/stream /api/img：用 HMAC 签名鉴权
//
// 为什么代理路由必须排除：
//   1) hls.js 的 XHR 会带 cookie/凭据，但 <video> 原生拉流、以及 VLC / .strm /
//      外部播放器不会带 Basic Auth 头 —— 不排除就全部 401；
//   2) 代理地址本身已经有 HMAC 签名 + 过期时间 + 前缀绑定，安全强度不依赖 Basic Auth。
export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron|api/stream|api/img).*)"],
};

/** 定长比较，避免时序侧信道 */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const SECURITY_HEADERS: Record<string, string> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "SAMEORIGIN",
	"permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function withSecurity(res: NextResponse): NextResponse {
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
	return res;
}

/**
 * 给首次访问的客户端签发一个匿名标识，供限流分桶用。
 *
 * 【为什么放在中间件】
 * 限流按 `cf-connecting-ip` 计数在 CGNAT 下会把同一出口下的所有用户混成一个桶
 * （详见 lib/ratelimit.ts 里 rateIdentity 的注释），需要一个按客户端区分的依据。
 * 中间件是全站唯一收口的地方，在这里下发最省事。
 *
 * 只在缺失时下发：否则每个响应都要多带一个 Set-Cookie，纯浪费。
 */
function withClientId(req: NextRequest, res: NextResponse): NextResponse {
	if (readCookie(req, CLIENT_ID_COOKIE)) return res;
	try {
		res.headers.set(
			"set-cookie",
			clientIdCookie(newClientId(), req.nextUrl.protocol === "https:"),
		);
	} catch {
		/* 个别运行时可能不允许改响应头。忽略即可 —— 限流会自动退回纯 IP。 */
	}
	return res;
}

export function middleware(req: NextRequest) {
	const { env } = getCloudflareContext();
	const user = env.USERNAME;
	const pass = env.PASSWORD;
	if (!user || !pass) return withClientId(req, withSecurity(NextResponse.next())); // 未配置则不鉴权

	const auth = req.headers.get("authorization");
	if (auth) {
		const [scheme, encoded] = auth.split(" ");
		if (scheme === "Basic" && encoded) {
			try {
				const decoded = atob(encoded);
				const idx = decoded.indexOf(":");
				const u = decoded.slice(0, idx);
				const p = decoded.slice(idx + 1);
				if (safeEqual(u, user) && safeEqual(p, pass)) {
					return withClientId(req, withSecurity(NextResponse.next()));
				}
			} catch {
				// 非法 base64，当作鉴权失败处理
			}
		}
	}
	// 401 也带上标识：万一这个 IP 已经被别人挤到限额，重试时就能拿到自己的桶
	return withClientId(
		req,
		new NextResponse("Authentication required", {
			status: 401,
			headers: { "WWW-Authenticate": 'Basic realm="AuroraTV"', ...SECURITY_HEADERS },
		}),
	);
}
