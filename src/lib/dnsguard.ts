// ============================================================================
// DNS 预解析校验（DoH）
// ----------------------------------------------------------------------------
// 【它要防的是什么】
// isSafeUpstream() 只能校验「URL 里写的东西」。`https://evil.example.com/x` 这个
// 字符串本身完全合法，但 evil.example.com 的 A 记录可以指向 127.0.0.1 或
// 169.254.169.254 —— 也就是经典的 DNS rebinding。静态字符串检查对此无能为力，
// 必须真的去解析一次。
//
// 【必须先说清楚：在 Cloudflare Workers 上，这一层的收益比传统服务器小得多】
// Worker 跑在 Cloudflare 边缘网络里，网络边界天然隔离了 RFC1918 内网 ——
// 它根本路由不到用户的自建内网，也够不到云厂商的 169.254.169.254 元数据服务。
// 所以传统 SSRF 最致命的那条路径在这里本来就是断的。
// 这一层的真实价值是「纵深防御」：把「解析到保留地址」这条路彻底堵死，
// 万一将来运行时策略变化、或者部署到别的平台，防护不会凭空消失。
//
// 【因此：查询失败时选择 fail-open（放行）】
// 这是本模块唯一一个「安全让位于可用性」的决定，理由：
//   1) 上面说了，Workers 的网络边界已经承担了主要防线，这里只是补一层；
//   2) fail-closed 意味着 DoH 服务的任何抖动都会让【全站播放】立刻挂掉 ——
//      用一个真实且高频的可用性事故，去换一个在本平台上本就很难被利用的漏洞；
//   3) isSafeUpstream 的静态检查始终生效，不会因为这里放行而整体失守。
// 所以 DoH 查不通时放行，但**一定打日志**，让站长能在 logs 里看见。
//
// 【为什么用 DoH 而不是系统解析】
// Workers 运行时没有暴露 DNS 解析 API。Cloudflare 自己的 1.1.1.1 DoH JSON 接口
// 是唯一可用的途径。每次查询是一次子请求，所以缓存是必需的而非优化：
// 一个剧集的所有分片都在同一个 host 上，缓存命中后每次播放只多 1 次解析。
// ============================================================================

import { blockedIpLiteral, isIpLiteralHost } from "./ipaddr.ts";

const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** isolate 内存缓存：同一 isolate 内后续请求零成本 */
const MEM_TTL_MS = 5 * 60_000;
/** 边缘缓存：跨 isolate 共享，避免每个 isolate 都去查一次 */
const EDGE_TTL_SEC = 300;
const CACHE_HOST = "cache.auroratv.internal";

type Verdict = { ok: boolean; at: number };

const mem = new Map<string, Verdict>();

/**
 * 同一个 host 的并发解析合并。
 *
 * 【为什么这个不是优化，而是必需】
 * 一个搜索页会并发加载上百张海报，它们绝大多数来自同一个图床 host。
 * 缓存未命中时（新 isolate、或刚过 TTL），如果不去重，就会在几十毫秒内
 * 对同一个域名打出上百次 DoH 查询 —— 白白烧掉并发连接，还可能被 DoH 侧限流。
 * 合并之后，同一时刻每个 host 最多只有 1 次真实查询，其余全部复用它。
 */
const inflight = new Map<string, Promise<boolean>>();

/** 仅供单测：清空 isolate 内缓存 */
export function __resetDnsCache(): void {
	mem.clear();
	inflight.clear();
}

/** 仅供单测：当前缓存条目数 */
export function __dnsCacheSize(): number {
	return mem.size;
}

type EdgeCache = {
	match(req: Request): Promise<Response | null>;
	put(req: Request, res: Response): Promise<void>;
};

function getEdgeCache(): EdgeCache | null {
	try {
		return (caches as unknown as { default?: EdgeCache }).default ?? null;
	} catch {
		return null;
	}
}

function keyToRequest(host: string): Request {
	return new Request("https://" + CACHE_HOST + "/dns/" + encodeURIComponent(host));
}

async function readEdge(host: string): Promise<boolean | null> {
	const c = getEdgeCache();
	if (!c) return null;
	try {
		const hit = await c.match(keyToRequest(host));
		if (!hit) return null;
		const t = await hit.text();
		if (t === "1") return true;
		if (t === "0") return false;
		return null;
	} catch {
		return null;
	}
}

async function writeEdge(host: string, ok: boolean): Promise<void> {
	const c = getEdgeCache();
	if (!c) return;
	try {
		await c.put(
			keyToRequest(host),
			new Response(ok ? "1" : "0", {
				headers: {
					"content-type": "text/plain",
					"cache-control": "max-age=" + EDGE_TTL_SEC,
				},
			}),
		);
	} catch {
		/* 缓存写失败只是少一次加速，不影响判定 */
	}
}

function memGet(host: string): boolean | null {
	const v = mem.get(host);
	if (!v) return null;
	if (Date.now() - v.at > MEM_TTL_MS) {
		mem.delete(host);
		return null;
	}
	return v.ok;
}

function memSet(host: string, ok: boolean): void {
	// 简单的容量保护：正常部署下 host 数量是几十，超过就整体清空重来，
	// 避免被「每次请求换一个随机域名」的攻击把内存撑爆。
	if (mem.size > 500) mem.clear();
	mem.set(host, { ok, at: Date.now() });
}

type DohAnswer = {
	Status?: number;
	Answer?: Array<{ type?: number; data?: string }>;
};

/**
 * 查一条 A / AAAA 记录。
 * 返回 null 表示「查询本身失败」（网络 / 非 2xx / 非法 JSON）—— 与「查到但没有记录」
 * 的 [] 是两回事，调用方必须区别对待。
 */
async function queryDoh(host: string, type: "A" | "AAAA"): Promise<string[] | null> {
	const wantType = type === "A" ? 1 : 28;
	try {
		const res = await fetch(
			DOH_URL + "?name=" + encodeURIComponent(host) + "&type=" + type,
			{ headers: { accept: "application/dns-json" } },
		);
		if (!res.ok) return null;
		const data = (await res.json()) as DohAnswer;
		if (typeof data?.Status !== "number") return null;
		const out: string[] = [];
		for (const a of data.Answer ?? []) {
			// 必须按 type 过滤：Answer 里同时会有 CNAME(5) 记录，
			// 它的 data 是域名而不是 IP，混进来会被误判成「解析不出 IP」。
			if (a?.type === wantType && typeof a.data === "string") out.push(a.data);
		}
		return out;
	} catch {
		return null;
	}
}

/** 解析并判定。返回 null 表示「无法判定」（DoH 不可用），调用方按 fail-open 处理。 */
async function resolveAndCheck(host: string): Promise<boolean | null> {
	const [a, aaaa] = await Promise.all([queryDoh(host, "A"), queryDoh(host, "AAAA")]);

	// 两个查询都没成功 -> DoH 整体不可用
	if (a === null && aaaa === null) return null;

	const ips = [...(a ?? []), ...(aaaa ?? [])];

	// 查询成功了但一条记录都没有：域名根本解析不出来。
	// 这不是「放行」的理由 —— fetch 到这样的地址也只会失败，直接拒绝更干净。
	if (ips.length === 0) return false;

	for (const ip of ips) {
		const blocked = blockedIpLiteral(ip);
		// blocked === true  -> 明确是内网 / 回环 / 保留地址
		// blocked === null  -> 解析出来的东西根本不是 IP，属于异常数据，一并拒绝
		if (blocked !== false) return false;
	}
	return true;
}

/** 边缘缓存 + 真实解析。由 verifyHostResolvesPublic 通过 inflight 去重后调用。 */
async function resolveCached(host: string): Promise<boolean> {
	const cachedEdge = await readEdge(host);
	if (cachedEdge !== null) return cachedEdge;

	const verdict = await resolveAndCheck(host);

	// DoH 整体不可用：放行（fail-open），并且【不写边缘缓存】——
	// 否则一次网络抖动会被缓存 5 分钟，把故障悄悄藏起来。
	if (verdict === null) {
		console.warn("[auroratv] DNS 预解析不可用（DoH 查询失败），本次放行主机校验：" + host);
		return true;
	}

	void writeEdge(host, verdict);
	return verdict;
}

/**
 * 校验主机名解析出来的地址是否全部可公网路由。
 *
 * 域名以外的输入直接返回 true：IP 字面量的静态判定在 isSafeUpstream 里已经做过，
 * 这里重复判定只会让两处规则有机会漂移。
 */
export async function verifyHostResolvesPublic(host: string): Promise<boolean> {
	const h = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (!h) return false;
	if (isIpLiteralHost(h)) return true;

	const cachedMem = memGet(h);
	if (cachedMem !== null) return cachedMem;

	// 同一 host 的并发请求共用一次解析
	let pending = inflight.get(h);
	if (!pending) {
		pending = resolveCached(h).finally(() => inflight.delete(h));
		inflight.set(h, pending);
	}

	const verdict = await pending;
	// fail-open 的结果也写内存缓存：DoH 挂掉时不该每个请求都重试一遍。
	// 它只在 isolate 内存里活 5 分钟，不写边缘缓存，所以不会掩盖故障。
	memSet(h, verdict);
	return verdict;
}
