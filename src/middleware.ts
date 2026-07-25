import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

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

export function middleware(req: NextRequest) {
	const { env } = getCloudflareContext();
	const user = env.USERNAME;
	const pass = env.PASSWORD;
	if (!user || !pass) return withSecurity(NextResponse.next()); // 未配置则不鉴权

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
					return withSecurity(NextResponse.next());
				}
			} catch {
				// 非法 base64，当作鉴权失败处理
			}
		}
	}
	return new NextResponse("Authentication required", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="AuroraTV"', ...SECURITY_HEADERS },
	});
}
