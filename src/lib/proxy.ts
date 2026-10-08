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
// ============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 代理签名默认有效期：12 小时（长剧集连续播放也够用） */
export const DEFAULT_TOKEN_TTL = 60 * 60 * 12;

export type ProxyEnv = {
	STREAM_SECRET?: string;
	CRON_SECRET?: string;
	PASSWORD?: string;
};

/**
 * 代理签名密钥。优先用专用 STREAM_SECRET；未配置时退回 CRON_SECRET / PASSWORD，
 * 保证「没配任何 secret 的裸部署」也能开箱即用（此时安全性较弱，会在 /api/health 提示）。
 */
export function getProxySecret(env: ProxyEnv): string {
	return (
		env.STREAM_SECRET ||
		env.CRON_SECRET ||
		env.PASSWORD ||
		"auroratv-default-insecure-secret"
	);
}

export function isProxySecretWeak(env: ProxyEnv): boolean {
	return !env.STREAM_SECRET && !env.CRON_SECRET && !env.PASSWORD;
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
 * IPv4 是否属于「公网可路由」。
 * 与 WHATWG URL 解析器配合：`http://0x7f000001/`、`http://2130706433/`、
 * `http://0177.0.0.1/` 这类八进制/十六进制/整数写法都会被规范化成点分十进制，
 * 因此这里只需处理点分十进制。
 */
function isPublicIpv4(a: number, b: number): boolean {
	if (a === 0 || a === 10 || a === 127) return false; // 未指定 / 私网 / 回环
	if (a === 169 && b === 254) return false; // 链路本地，含云元数据 169.254.169.254
	if (a === 172 && b >= 16 && b <= 31) return false; // 私网
	if (a === 192 && b === 168) return false; // 私网
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
	if (a === 192 && b === 0) return false; // 192.0.0.0/24 协议保留
	if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试
	if (a >= 224) return false; // 组播 / 保留 / 广播
	return true;
}

/**
 * 把 IPv6 字面量（不含方括号）解析成 8 个 16 位分组。
 *
 * 【为什么必须按位解析，而不是正则匹配字符串】
 * `http://[::ffff:127.0.0.1]/` 会被 WHATWG URL 解析器规范化成 `[::ffff:7f00:1]`。
 * 旧实现只比对 `::1` / `fc00::/7` / `fe80::` 三个字符串前缀，
 * `::ffff:7f00:1` 一个都不命中 —— 于是「回环地址」被判定为安全，
 * 重定向到内网也就绕过了整层 SSRF 防护。按位展开后这类地址无从隐藏。
 */
function parseIpv6(host: string): number[] | null {
	const h = host.split("%")[0]; // 去掉 zone id（fe80::1%eth0）
	const halves = h.split("::");
	if (halves.length > 2) return null;

	const parseParts = (parts: string[]): number[] | null => {
		const out: number[] = [];
		for (const p of parts) {
			if (/^\d{1,3}(\.\d{1,3}){3}$/.test(p)) {
				// 尾部内嵌的 IPv4（::ffff:127.0.0.1）
				const v4 = p.split(".").map(Number);
				if (v4.some((n) => n > 255)) return null;
				out.push(((v4[0] << 8) | v4[1]) & 0xffff, ((v4[2] << 8) | v4[3]) & 0xffff);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
			out.push(parseInt(p, 16));
		}
		return out;
	};

	const head = parseParts(halves[0] ? halves[0].split(":") : []);
	const tail = parseParts(halves.length === 2 && halves[1] ? halves[1].split(":") : []);
	if (!head || !tail) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;
	return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** IPv6 是否属于「不可路由到公网」的地址段。解析失败一律视为危险。 */
function isBlockedIpv6(host: string): boolean {
	const g = parseIpv6(host);
	if (!g) return true;
	const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

	if (zero(0, 8)) return true; // :: 未指定
	if (zero(0, 7) && g[7] === 1) return true; // ::1 回环
	// IPv4 映射 ::ffff:0:0/96 与 IPv4 兼容 ::/96（已废弃）—— 一律由内嵌的 v4 决定。
	// `::` 与 `::1` 已在上面被拦截，不会走到这里。
	// 内嵌 v4 的前两段落在 g[6]：高字节 = 第一段，低字节 = 第二段。
	if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) {
		return !isPublicIpv4(g[6] >> 8, g[6] & 0xff);
	}
	if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
	if ((g[0] & 0xffc0) === 0xfe80) return true; // 链路本地 fe80::/10
	if ((g[0] & 0xff00) === 0xff00) return true; // 组播 ff00::/8
	if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96
	if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo 2001::/32
	if (g[0] === 0x2002) return !isPublicIpv4(g[1] >> 8, g[1] & 0xff); // 6to4 内嵌 v4
	return false;
}

/**
 * 只允许公网 http(s)。内网 / 回环 / 链路本地 / 云元数据地址一律拒绝，
 * 避免代理被用来探测 Cloudflare 内部或用户自建网络。
 */
export function isSafeUpstream(raw: string): boolean {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;

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

	// 含冒号 => IPv6 字面量（主机名不允许出现冒号），交给按位解析
	if (host.includes(":")) return !isBlockedIpv6(host);

	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
		if (octets.some((n) => n > 255)) return false;
		return isPublicIpv4(octets[0], octets[1]);
	}
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
 */
export async function guardedFetch(
	target: string,
	opts: GuardedFetchOptions = {},
): Promise<GuardedFetchResult> {
	const doFetch = opts.fetcher ?? fetch;
	const method = opts.method ?? "GET";
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
