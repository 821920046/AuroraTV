import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// 站长鉴权：HTTP Basic Auth 保护全站。
// 排除静态资源与 /api/cron（后者用自己的 secret 鉴权）。
export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron).*)"],
};

export function middleware(req: NextRequest) {
	const { env } = getCloudflareContext();
	const user = env.USERNAME;
	const pass = env.PASSWORD;
	if (!user || !pass) return NextResponse.next(); // 未配置则不鉴权

	const auth = req.headers.get("authorization");
	if (auth) {
		const [scheme, encoded] = auth.split(" ");
		if (scheme === "Basic" && encoded) {
			const decoded = atob(encoded);
			const idx = decoded.indexOf(":");
			const u = decoded.slice(0, idx);
			const p = decoded.slice(idx + 1);
			if (u === user && p === pass) return NextResponse.next();
		}
	}
	return new NextResponse("Authentication required", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="AuroraTV"' },
	});
}
