// ============================================================================
// 同源流媒体代理：签名 / 校验 / 播放列表改写 / 守卫取流
// ----------------------------------------------------------------------------
// 【为什么必须有这一层 —— 第一性原理】
// 浏览器播放 HLS 的硬性前提有三条，缺一不可：
//   1) 页面是 https 时，所有子资源必须也是 https（Mixed Content 规则，浏览器直接拦截）；
//   2) 用 MSE/hls.js 拉流时，m3u8 与每个 ts 分片都必须带 Access-Control-Allow-Origin；
//   3) 很多采集站 CDN 有 Referer/UA 防盗链，浏览器发出的请求头无法伪造。
// 采集站的播放地址大量是 http、无 CORS、带防盗链 —— 这三条同时踩中。
// 因此「绝不中转视频流」的原设计在浏览器里是数学上不可能成立的，
// 这就是「点播放没反应」的病因，而不是源失效。
//
// 解法：Worker 侧做一层同源代理，把 http→https、补 CORS 头、补 Referer/UA，
// 并把 m3u8 里的所有子地址（分片 / 密钥 / 多码率子列表）改写成同样走代理的地址。
// 为了不变成开放代理（SSRF / 被人当图床和流量中转），所有代理地址都必须带
// HMAC-SHA256 签名，且签名绑定「URL 前缀 + 过期时间」，一条播放列表只需签一次。
//
// 【关于 import】
// 本模块只 import 同目录下两个同样零依赖的模块（ipaddr / dnsguard），
// 它们自身不 import 任何东西，因此整条依赖链仍可被 Node 测试运行器直接加载。
// 任何引入外部包或 `@/lib/*` 别名的改动都会破坏 src/lib/proxy.test.mts，
// 这是刻意维持的约束，不是疏忽。
// ============================================================================

import { blockedIpLiteral } from "./ipaddr.ts";
import { verifyHostResolvesPublic } from "./dnsguard.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 代理签名默认有效期：12 小时（长剧集连续播放也够用） */
export const DEFAULT_TOKEN_TTL = 60 * 60 * 12;

export type ProxyEnv = {
	STREAM_SECRET?: string;
	CRON_SECRET?: string;
};

/**
 * 最后的兜底密钥。**这是一个公开常量，等价于「没有密钥」**：
 * 任何人拿它就能铸出合法令牌。只有在「既没配 STREAM_SECRET / CRON_SECRET、
 * 又读不到 D1 持久化密钥」时才会用到；届时 /api/health 会明确报出 weak 状态。
 *
 * 之所以仍然保留一个可用的兜底值（而不是直接拒绝签发）：
 * 直接拒绝会让「只配了 PASSWORD 的老部署」升级后立刻播不了 ——
 * 那是破坏性变更。现在的做法是「首次访问自动生成持久化密钥」（见 lib/db.ts），
 * 既不改部署者任何配置，又让可预测的默认密钥在正常路径上彻底消失。
 */
export const INSECURE_DEFAULT_SECRET = "auroratv-default-insecure-secret";

/**
 * 取「显式配置」的签名密钥；都没配则返回 null，由调用方去 D1 取持久化密钥。
 *
 * 【为什么这里刻意不含 PASSWORD】
 *   1) PASSWORD 是 Basic Auth 的登录口令，通常是人手敲的短口令，熵极低；
 *   2) 把「后台登录口令」复用成「签名密钥」，意味着改口令会让所有已发出的
 *      播放链接立即失效 —— 两件事的轮换周期完全不同，不该绑在一起；
 *   3) 最关键的是：PASSWORD 一旦泄漏，攻击者拿到的不只是后台，还有
 *      「铸造任意代理令牌」的能力。职责分离，签名只认专用密钥。
 */
export function getExplicitSecret(env: ProxyEnv): string | null {
	return env.STREAM_SECRET || env.CRON_SECRET || null;
}

/** 密钥选择优先级：显式配置 > D1 持久化随机密钥 > 公开兜底常量。 */
export function pickSecret(explicit: string | null, persisted: string | null): string {
	return explicit || persisted || INSECURE_DEFAULT_SECRET;
}

/** 该密钥是否处于「无防护」状态（即回退到了公开常量）。 */
export function isProxySecretWeak(secret: string): boolean {
	return secret === INSECURE_DEFAULT_SECRET;
}

// ---------------------------------------------------------------- base64url

function bytesToB64Url(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlEncode(text: string): string {
	return bytesToB64Url(enc.encode(text));
}

export function b64urlDecode(text: string): string {
	const norm = text.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return dec.decode(bytes);
}

// ---------------------------------------------------------------- HMAC

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
	let k = keyCache.get(secret);
	if (!k) {
		k = crypto.subtle.importKey(
			"raw",
			enc.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		keyCache.set(secret, k);
	}
	return k;
}

async function sign(secret: string, msg: string): Promise<string> {
	const key = await importKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
	return bytesToB64Url(new Uint8Array(sig));
}

/** 定长比较，避免时序侧信道 */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ---------------------------------------------------------------- SSRF 防护

/**
 * 允许代理的上游端口。
 *
 * 【为什么是白名单而不是黑名单】
 * 危险端口有 65535 个，黑名单要穷举它们 —— 漏一个是必然的，而且新端口随时会出现。
 * 反过来，采集站的流地址实际上只用 80/443，8080/8443 留作余量。白名单只要 5 项就够。
 *
 * 空字符串代表 URL 的默认端口：WHATWG URL 会把 `http://x.com:80/` 规范化成
 * `http://x.com/`（port 为 ""），所以默认端口必须显式列进来。
 *
 * 附带的收益：把「用代理探测内网某端口是否开放」这条路一并封死。
 */
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/**
 * 只允许公网 http(s) 的常见端口。内网 / 回环 / 链路本地 / 云元数据地址一律拒绝，
 * 避免代理被用来探测 Cloudflare 内部或用户自建网络。
 *
 * IP 字面量的判定委托给 lib/ipaddr.ts —— 与 DNS 预解析共用同一份实现，
 * 不会再出现「一处修好、另一处漏掉」。
 */
export function isSafeUpstream(raw: string): boolean {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	if (!ALLOWED_PORTS.has(u.port)) return false;

	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!host) return false;
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".internal") ||
		host.endsWith(".local") ||
		host === "metadata.google.internal"
	)
		return false;

	// blocked === null 表示「这不是 IP 字面量」，也就是普通域名：
	// 字面量层面无可判定，交给 dnsguard 的预解析去查它到底指向哪里。
	const blocked = blockedIpLiteral(host);
	if (blocked !== null) return !blocked;
	return true;
}

// ---------------------------------------------------------------- 守卫取流

/** 最多跟随多少跳重定向 */
export const MAX_REDIRECTS = 3;

export type GuardedFetchOptions = {
	method?: "GET" | "HEAD";
	/**
	 * 请求头。允许传函数 —— Referer 必须按「当前这一跳」的域名重新生成，
	 * 跳转后仍带旧域名的 Referer 会被源站拒掉。
	 */
	headers?: Record<string, string> | ((url: string) => Record<string, string>);
	/** Cloudflare 边缘缓存选项，逐跳透传给子请求 */
	cf?: Record<string, unknown>;
	/** 便于单测注入；生产环境用全局 fetch */
	fetcher?: typeof fetch;
	/**
	 * 主机名解析校验，逐跳执行。
	 *
	 * 缺省使用 dnsguard 的 DoH 预解析（DNS rebinding 纵深防御）。
	 * 单测**必须显式传 null**：否则每个用例都会真的去查一次外网 DoH，
	 * 测试会变慢、变脆，还会依赖网络。
	 */
	verifyHost?: ((host: string) => Promise<boolean>) | null;
};

export type GuardedFetchResult =
	| { ok: true; res: Response; finalUrl: string }
	| { ok: false; error: string };

export function hostOf(raw: string): string {
	try {
		return new URL(raw).host;
	} catch {
		return "invalid-url";
	}
}

/** 只取主机名（去掉端口与 IPv6 方括号），供 DNS 校验使用。 */
function hostnameOf(raw: string): string {
	try {
		return new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return "";
	}
}

async function cancelBody(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		/* ignore */
	}
}

/**
 * 带 SSRF 防护的取流：手动跟随重定向，**每一跳都重新做地址校验**。
 *
 * 【为什么必须手动跟随】
 * 签名只绑定「发起请求的那个 URL」。若用 `redirect: "follow"`，一个通过校验的
 * 公网地址完全可以 302 到 `http://169.254.169.254/…`（云元数据）或
 * `http://127.0.0.1/…`，校验形同虚设 —— 这正是典型的 SSRF 重定向绕过。
 * 这里改为 `redirect: "manual"`，逐跳校验后再继续。
 *
 * 【运行时差异兜底】
 * Cloudflare Workers 的 `manual` 会返回真实 3xx（Location 可读），
 * 而浏览器语义会返回 opaqueredirect（status 0、响应头不可读）。
 * 万一落到后者，就退回 `follow`，但事后用 `res.url` 校验最终落点 ——
 * 宁可校验得晚一点，也不能让重定向把 SSRF 防护整个绕过去。
 *
 * 【两层校验，逐跳都做】
 *   第一层 isSafeUpstream：纯字符串判定，零成本。管住「URL 里直接写内网 IP」
 *     以及「重定向到内网 IP」，包括 `[::ffff:7f00:1]` 这类被 URL 解析器规范化过的形式。
 *   第二层 verifyHost：域名必须真的解析一次，管住「域名指向内网」的 DNS rebinding。
 *     它有一次子请求开销，所以 dnsguard 里做了 isolate 内存 + 边缘两级缓存。
 */
export async function guardedFetch(
	target: string,
	opts: GuardedFetchOptions = {},
): Promise<GuardedFetchResult> {
	const doFetch = opts.fetcher ?? fetch;
	const method = opts.method ?? "GET";
	// undefined = 用默认实现；null = 显式关闭（单测）；函数 = 注入
	const verifyHost = opts.verifyHost === undefined ? verifyHostResolvesPublic : opts.verifyHost;
	const headersFor = (u: string): Record<string, string> | undefined =>
		typeof opts.headers === "function" ? opts.headers(u) : opts.headers;
	const baseInit = {
		method,
		...(opts.cf ? { cf: opts.cf } : {}),
	};

	let url = target;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!isSafeUpstream(url)) {
			return { ok: false, error: `blocked upstream after ${hop} redirect(s): ${hostOf(url)}` };
		}
		// 静态校验只看得懂字面量。`https://evil.example.com/x` 这个字符串本身完全合法，
		// 但它的 A 记录可以指向 127.0.0.1 —— 也就是 DNS rebinding，只能真的解析一次。
		if (verifyHost) {
			const host = hostnameOf(url);
			if (!host || !(await verifyHost(host))) {
				return {
					ok: false,
					error: `blocked upstream (dns) after ${hop} redirect(s): ${hostOf(url)}`,
				};
			}
		}
		const res = await doFetch(url, {
			...baseInit,
			headers: headersFor(url),
			redirect: "manual",
		} as RequestInit);

		if (res.status === 0 || res.type === "opaqueredirect") {
			const followed = await doFetch(url, {
				...baseInit,
				headers: headersFor(url),
				redirect: "follow",
			} as RequestInit);
			if (!isSafeUpstream(followed.url)) {
				await cancelBody(followed);
				return { ok: false, error: `blocked redirect target: ${hostOf(followed.url)}` };
			}
			// 这条路径是「事后校验」，落点已经真的被请求过了，所以第二层更不能省。
			if (verifyHost) {
				const finalHost = hostnameOf(followed.url);
				if (!finalHost || !(await verifyHost(finalHost))) {
					await cancelBody(followed);
					return {
						ok: false,
						error: `blocked redirect target (dns): ${hostOf(followed.url)}`,
					};
				}
			}
			return { ok: true, res: followed, finalUrl: followed.url };
		}

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			await cancelBody(res);
			if (!location) return { ok: false, error: "redirect without location" };
			try {
				url = new URL(location, url).toString();
			} catch {
				return { ok: false, error: "malformed redirect location" };
			}
			continue;
		}
		return { ok: true, res, finalUrl: url };
	}
	return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})` };
}

// ---------------------------------------------------------------- 令牌

/** 目录级前缀：同一播放列表下的所有分片共用一个签名，签一次用到底。 */
export function urlPrefix(raw: string): string {
	const u = new URL(raw);
	return u.origin + u.pathname.replace(/[^/]*$/, "");
}

/** 站点级前缀：给海报 / 台标这类同域大量小文件用。 */
export function hostPrefix(raw: string): string {
	return new URL(raw).origin + "/";
}

export async function mintToken(
	secret: string,
	prefix: string,
	ttl: number = DEFAULT_TOKEN_TTL,
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + ttl;
	const sig = await sign(secret, exp + "|" + prefix);
	return exp + "." + b64urlEncode(prefix) + "." + sig;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyToken(
	secret: string,
	token: string | null,
	target: string,
): Promise<VerifyResult> {
	if (!token) return { ok: false, reason: "missing token" };
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "malformed token" };
	const exp = Number(parts[0]);
	if (!Number.isFinite(exp)) return { ok: false, reason: "bad expiry" };
	if (exp * 1000 < Date.now()) return { ok: false, reason: "token expired" };

	let prefix: string;
	try {
		prefix = b64urlDecode(parts[1]);
	} catch {
		return { ok: false, reason: "bad prefix" };
	}
	const expect = await sign(secret, exp + "|" + prefix);
	if (!safeEqual(expect, parts[2])) return { ok: false, reason: "bad signature" };
	if (!target.startsWith(prefix)) return { ok: false, reason: "prefix mismatch" };
	if (!isSafeUpstream(target)) return { ok: false, reason: "blocked upstream" };
	return { ok: true };
}

// ---------------------------------------------------------------- 铸币机

/**
 * 一次请求内复用签名：按前缀缓存，改写一条 500 片的播放列表也只做 1 次 HMAC。
 *
 * 注意：这里刻意【不用】TS 的构造函数参数属性（`constructor(private x: T)`）——
 * 那属于不可擦除语法，会让本模块无法被 Node 的 strip-only 模式直接加载，
 * 也就跑不了单测。显式字段声明虽然啰嗦，但换来了可测性。
 */
export class TokenMinter {
	private readonly cache = new Map<string, Promise<string>>();
	private readonly secret: string;
	private readonly ttl: number;

	constructor(secret: string, ttl: number = DEFAULT_TOKEN_TTL) {
		this.secret = secret;
		this.ttl = ttl;
	}

	private token(prefix: string): Promise<string> {
		let t = this.cache.get(prefix);
		if (!t) {
			t = mintToken(this.secret, prefix, this.ttl);
			this.cache.set(prefix, t);
		}
		return t;
	}

	/** 视频 / 播放列表 / 分片 -> /api/stream?... */
	async streamUrl(rawUrl: string): Promise<string> {
		if (!isSafeUpstream(rawUrl)) return rawUrl;
		const t = await this.token(urlPrefix(rawUrl));
		return "/api/stream?u=" + encodeURIComponent(rawUrl) + "&t=" + t;
	}

	/** 海报 / 台标 -> /api/img?... （站点级签名，命中率高） */
	async imageUrl(rawUrl: string): Promise<string> {
		if (!isSafeUpstream(rawUrl)) return rawUrl;
		const t = await this.token(hostPrefix(rawUrl));
		return "/api/img?u=" + encodeURIComponent(rawUrl) + "&t=" + t;
	}
}

// ---------------------------------------------------------------- 播放列表改写

export function looksLikePlaylistUrl(u: string): boolean {
	return /\.m3u8?($|[?#])/i.test(u);
}

export function looksLikePlaylistType(contentType: string | null): boolean {
	return !!contentType && /mpegurl|x-mpegurl|vnd\.apple\.mpegurl|m3u/i.test(contentType);
}

// 这些标签里的 URI="..." 同样需要改写，否则 AES-128 加密流 / fMP4 初始化段 / 多语轨会漏网
const URI_TAG_RE =
	/^#EXT-X-(KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)/i;

function safeResolve(u: string, base: string): string | null {
	try {
		const abs = new URL(u, base).toString();
		return /^https?:/i.test(abs) ? abs : null;
	} catch {
		return null;
	}
}

async function rewriteUriAttrs(
	line: string,
	base: string,
	minter: TokenMinter,
): Promise<string> {
	const re = /URI="([^"]*)"/gi;
	const out: string[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line))) {
		out.push(line.slice(last, m.index));
		const abs = m[1] ? safeResolve(m[1], base) : null;
		out.push(abs ? 'URI="' + (await minter.streamUrl(abs)) + '"' : m[0]);
		last = m.index + m[0].length;
	}
	out.push(line.slice(last));
	return out.join("");
}

/**
 * 把 m3u8 内的所有地址改写成同源代理地址。
 * base 必须是「跟随重定向之后」的最终 URL，否则相对路径会解析错。
 */
export async function rewritePlaylist(
	text: string,
	base: string,
	minter: TokenMinter,
): Promise<string> {
	const lines = text.split(/\r?\n/);
	const out: string[] = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const t = line.trim();
		if (!t) {
			out[i] = line;
			continue;
		}
		if (t.startsWith("#")) {
			out[i] = URI_TAG_RE.test(t) && /URI="/i.test(t) ? await rewriteUriAttrs(line, base, minter) : line;
			continue;
		}
		const abs = safeResolve(t, base);
		out[i] = abs ? await minter.streamUrl(abs) : line;
	}
	return out.join("\n");
}

/** 判断是否为直播列表（无 ENDLIST）：直播列表不能长缓存，否则画面会卡住不更新。 */
export function isLivePlaylist(text: string): boolean {
	return !/#EXT-X-ENDLIST/i.test(text) && /#EXTINF/i.test(text);
}
