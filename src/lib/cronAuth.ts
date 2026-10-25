import { safeEqual } from "./safeEqual.ts";

/**
 * cron 端点鉴权：**优先 `Authorization: Bearer`**，同时兼容 `?secret=`。
 *
 * 【为什么两种都要】
 * 查询串会把密钥写进访问日志、Referer、浏览器历史，
 * 是更差的传递方式；但已部署的调度 Worker 用的就是 `?secret=`，
 * 直接砍掉会让老部署在升级后集体 401。所以新方式设为推荐，旧方式保留。
 *
 * 【为什么定长比较】
 * 裸 `!==` 在首个不同字符处就返回，密钥前缀可被逐字节探出来。
 *
 * 只依赖 NextRequest 的这两个成员（结构化类型），
 * 单测里用普通对象就能构造，不必启动 Next 运行时。
 */
export type CronRequestLike = {
	headers: { get: (name: string) => string | null };
	nextUrl: { searchParams: { get: (name: string) => string | null } };
};

/** Bearer 头：scheme 后至少一个空白字符，token 取到行尾 */
const BEARER_RE = /^Bearer[ \t]+(.+)$/i;

export function isCronAuthorized(req: CronRequestLike, secret: string | undefined): boolean {
	// 没配密钥时一律拒绝：否则 safeEqual("", "") 会为真，
	// 一个空的 ?secret= 就能打通未配置的部署。
	if (!secret) return false;

	const auth = req.headers.get("authorization");
	if (auth) {
		const m = BEARER_RE.exec(auth.trim());
		if (m && safeEqual(m[1].trim(), secret)) return true;
	}

	const q = req.nextUrl.searchParams.get("secret");
	return !!q && safeEqual(q, secret);
}
