// ============================================================================
// 应用层限流（Cache API 固定窗口计数）
// ----------------------------------------------------------------------------
// 【第一性原理：为什么限流放在应用层，以及它到底能防住什么】
//
// 真正有效的边缘限流是 Cloudflare 控制台的 Rate Limiting Rules —— 它在请求
// 进入 Worker 之前就生效，不消耗任何 Worker CPU。本项目【仍然建议站长去配】。
// 但它是「运维动作」，不是「代码保证」：换一个部署环境、换一个账号，
// 这层防护就凭空消失了。所以这里再补一层应用层兜底，让仓库自身带着防护能力。
//
// 【为什么不能用 KV 或 D1 计数】
//   - KV 免费额度只有 1000 次写/天。限流是「每个请求都要写一次」的负载，
//     用它等于第一分钟就把额度烧光，还会把正常缓存写入一起拖死。
//   - D1 免费额度 10 万行写/天，同样扛不住，且每次计数多一次跨区往返。
//   - Cache API 免费、不限次数、同 colo 内延迟极低 —— 是唯一合适的选择。
//
// 【Cache API 计数的固有局限，必须说清楚】
//   1) cache 是按 colo 隔离的：同一个攻击者被调度到 10 个 colo，就相当于有 10 倍额度。
//      这是「近似限流」，不是精确配额 —— 它的定位是挡住「单点脚本刷」，不是做计费。
//   2) 读-改-写有竞态：N 个并发请求可能读到同一个计数值，于是实际放行数会略高于限额。
//      方向是「偏宽松」，对兜底场景可接受；要做精确限流只能上 Durable Objects（付费）。
//   3) cache 条目可能被提前驱逐 → 计数归零 → 限流暂时失效。同样是偏宽松。
//   三点合起来：**宁可漏放，不可误杀**。这正是下面所有阈值都留了数倍余量的原因。
//
// 【可用性优先】
//   Cache API 不存在（本地 dev / 非 Cloudflare 运行时）时一律放行。
//   限流组件故障绝不能把站点变成不可用 —— 与 lib/cache.ts 的容错原则一致。
// ============================================================================

/** 单个端点的限流规则。窗口固定为滑动近似（固定窗口），单位秒。 */
export type RateRule = {
	/** 窗口内允许的最大请求数 */
	limit: number;
	/** 窗口长度（秒） */
	windowSec: number;
};

/**
 * 各端点的限额。数值全部按「正常使用的数倍余量」来定，理由写在每一项后面。
 *
 * 注意 stream 与 img 的额度明显高于其它端点 —— 它们不是「人操作级」频率：
 * 一次 HLS 播放会按分片粒度发请求（6 秒一片 ≈ 10 次/分钟，2 秒一片 ≈ 30 次/分钟），
 * 一次搜索页会并发加载上百张海报。把这两个端点按「操作次数」限流会直接误杀正常用户。
 */
export const RATE_RULES: Record<string, RateRule> = {
	// 分片级流量。正常单用户 <30/分钟，多设备 + seek 预加载留 20 倍余量。
	stream: { limit: 600, windowSec: 60 },
	// 一个搜索页最多并发 120 张海报，留 5 倍余量。
	img: { limit: 600, windowSec: 60 },
	// 人手点击级：每次搜索要扇出到 8 个上游，是最贵的端点，给得最紧。
	search: { limit: 40, windowSec: 60 },
	// 切集 / 换源 / 换线路。前端已改为按需请求，正常一集一次。
	play: { limit: 80, windowSec: 60 },
	detail: { limit: 60, windowSec: 60 },
	// 首页聚合有边缘缓存，正常回源极少。
	home: { limit: 40, windowSec: 60 },
	// 播放成败上报：每次播放 1~2 次。
	sources: { limit: 120, windowSec: 60 },
	// 直播：频道列表 + 取流，切台频率低于点播。
	live: { limit: 120, windowSec: 60 },
};

/**
 * 路径 -> 限流桶。
 *
 * 【为什么用显式映射而不是正则提取】
 * 正则提取会把 /api/admin/* 也卷进来，而后台本来就有 Basic Auth；
 * 更重要的是「新增端点默认被限流」这件事必须是显式的 —— 一张表看全，
 * 比一条猜不出覆盖范围的规则安全得多。
 */
export function bucketOf(pathname: string): string | null {
	const p = pathname.replace(/\/+$/, "") || "/";
	if (p === "/api/stream") return "stream";
	if (p === "/api/img") return "img";
	if (p === "/api/search") return "search";
	if (p === "/api/play") return "play";
	if (p === "/api/detail") return "detail";
	if (p === "/api/home") return "home";
	if (p === "/api/sources") return "sources";
	if (p.startsWith("/api/live/")) return "live";
	return null;
}

/** 当前时间落在哪个窗口。返回值是「窗口序号」，不是时间戳。 */
export function windowIndex(nowMs: number, windowSec: number): number {
	if (!Number.isFinite(nowMs) || windowSec <= 0) return 0;
	return Math.floor(nowMs / (windowSec * 1000));
}

/**
 * 计数键。
 * 刻意把 bucket 与窗口序号都编进 key：换窗口就换 key，不需要任何清理逻辑，
 * 旧窗口的条目靠 cache 自身的 max-age 自然过期。
 */
export function rateKey(bucket: string, win: number, ip: string): string {
	return "rl:" + bucket + ":" + win + ":" + ip;
}

/**
 * 纯判定：给定「窗口内已计数」和限额，是否放行，以及放行后该写回多少。
 * 负数 / NaN / 小数（被投毒或被截断）一律按 0 处理。
 */
export function decide(
	prevCount: number,
	limit: number,
): { allowed: boolean; next: number } {
	const count = Number.isFinite(prevCount) && prevCount > 0 ? Math.floor(prevCount) : 0;
	if (count >= limit) return { allowed: false, next: count };
	return { allowed: true, next: count + 1 };
}

/**
 * 取客户端 IP。
 *
 * cf-connecting-ip 由 Cloudflare 边缘写入，客户端无法伪造（到达 Worker 前已被覆盖）。
 * x-forwarded-for 只在非 Cloudflare 环境（本地 dev）才可能用到，且它可被伪造 ——
 * 所以它排在最后，仅作为「让本地开发也能跑起来」的兜底。
 */
export function clientIp(req: Request): string {
	const h = req.headers;
	const cf = h.get("cf-connecting-ip");
	if (cf) return cf.trim();
	const real = h.get("x-real-ip");
	if (real) return real.trim();
	const xff = h.get("x-forwarded-for");
	if (xff) {
		const first = xff.split(",")[0]?.trim();
		if (first) return first;
	}
	return "unknown";
}

/** 本模块只依赖 Cache 的这两个方法 —— 抽成接口是为了单测能塞假实现进去。 */
export type MinimalCache = {
	match(req: Request): Promise<Response | null>;
	put(req: Request, res: Response): Promise<void>;
};

export type RateLimitOutcome =
	/** 放行（含「该路径不参与限流」和「限流组件不可用」两种情况） */
	| { limited: false }
	| { limited: true; bucket: string; rule: RateRule; retryAfterSec: number };

export type RateLimitDeps = {
	/** 注入用；缺省取 caches.default */
	cache?: MinimalCache | null;
	/** 注入用；缺省 Date.now() */
	nowMs?: number;
};

const CACHE_HOST = "cache.auroratv.internal";

function keyToRequest(key: string): Request {
	// 与 lib/cache.ts 用同一个内部 host，但路径前缀不同，避免与业务缓存串键。
	return new Request("https://" + CACHE_HOST + "/rl/" + encodeURIComponent(key));
}

function getDefaultCache(): MinimalCache | null {
	try {
		const c = (caches as unknown as { default?: MinimalCache }).default;
		return c ?? null;
	} catch {
		return null;
	}
}

async function readCount(cache: MinimalCache, key: string): Promise<number> {
	try {
		const hit = await cache.match(keyToRequest(key));
		if (!hit) return 0;
		const n = Number(await hit.text());
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	} catch {
		return 0;
	}
}

async function writeCount(
	cache: MinimalCache,
	key: string,
	count: number,
	ttlSec: number,
): Promise<void> {
	try {
		await cache.put(
			keyToRequest(key),
			new Response(String(count), {
				headers: {
					"content-type": "text/plain",
					// max-age 必须显式给，否则 cache.put 可能因「不可缓存」而静默丢弃。
					// 取 2 个窗口，保证跨越窗口边界时旧计数还在（不影响判定，只是少几次写）。
					"cache-control": "max-age=" + ttlSec,
				},
			}),
		);
	} catch {
		/* 写失败只是少计一次，绝不能让请求失败 */
	}
}

/**
 * 检查是否超过限额。**不修改任何响应** —— 由调用方决定 429 长什么样，
 * 因为 /api/stream 与 /api/play 的错误体格式本来就不同。
 */
export async function checkRateLimit(
	req: Request,
	deps: RateLimitDeps = {},
): Promise<RateLimitOutcome> {
	let pathname: string;
	try {
		pathname = new URL(req.url).pathname;
	} catch {
		return { limited: false };
	}
	const bucket = bucketOf(pathname);
	if (!bucket) return { limited: false };
	const rule = RATE_RULES[bucket];
	if (!rule) return { limited: false };

	const cache = deps.cache !== undefined ? deps.cache : getDefaultCache();
	if (!cache) return { limited: false };

	const nowMs = deps.nowMs ?? Date.now();
	const win = windowIndex(nowMs, rule.windowSec);
	const key = rateKey(bucket, win, clientIp(req));

	const prev = await readCount(cache, key);
	const { allowed, next } = decide(prev, rule.limit);
	if (!allowed) {
		// 距离本窗口结束还有多久 —— 客户端据此决定重试时机
		const winEndMs = (win + 1) * rule.windowSec * 1000;
		const retryAfterSec = Math.max(1, Math.ceil((winEndMs - nowMs) / 1000));
		return { limited: true, bucket, rule, retryAfterSec };
	}
	await writeCount(cache, key, next, rule.windowSec * 2);
	return { limited: false };
}

/**
 * 统一的 429 响应。
 *
 * 【为什么必须抽出来】
 * 上一轮的教训：/api/stream 修了 SSRF、/api/img 漏了，就是因为「两处各写各的」。
 * 限流有 8 个端点要接，各写一份 429 必然会出现「有的带 retry-after、有的不带」。
 *
 * retry-after 是 RFC 9110 标准头，客户端（和 Cloudflare 自己的日志）都认它，
 * 比只回一个 JSON 字段有用得多。
 */
export function rateLimitedResponse(
	outcome: Extract<RateLimitOutcome, { limited: true }>,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(
		JSON.stringify({
			code: 429,
			msg: "请求过于频繁，请稍后再试",
			bucket: outcome.bucket,
			retry_after: outcome.retryAfterSec,
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"retry-after": String(outcome.retryAfterSec),
				"x-aurora-ratelimit": outcome.bucket,
				...extraHeaders,
			},
		},
	);
}
