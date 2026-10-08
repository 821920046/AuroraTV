// ============================================================================
// 同源流媒体代理：签名 / 校验 / 播放列表改写
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
	// IPv6 回环 / ULA / 链路本地
	if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return false;

	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false; // 链路本地 / 云元数据
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
		if (a >= 224) return false; // 组播 / 保留
	}
	return true;
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
