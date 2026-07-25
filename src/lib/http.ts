// 统一的上游拉取层：超时 / 重试 / 伪装请求头 / 容错 JSON 解析。
// 病因备忘：很多 MacCMS 采集站会拒绝无 UA / 无 Referer 的请求（返回 403 或 HTML 验证页），
// 而原实现直接用裸 fetch + res.json()，一旦对方回 HTML 就抛错，表现为搜索/播放突然全失败。

export const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

export const MOBILE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** 给上游请求配一套「看起来像浏览器」的头，并用对方自己的域名做 Referer 绕过常见防盗链。 */
export function upstreamHeaders(
	targetUrl: string,
	extra?: Record<string, string>,
): Record<string, string> {
	let origin = "";
	try {
		origin = new URL(targetUrl).origin;
	} catch {
		/* ignore */
	}
	const h: Record<string, string> = {
		"user-agent": BROWSER_UA,
		accept: "*/*",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
	};
	if (origin) {
		h.referer = origin + "/";
		h.origin = origin;
	}
	return { ...h, ...(extra ?? {}) };
}

export type FetchOpts = {
	timeoutMs?: number;
	headers?: Record<string, string>;
	method?: string;
	redirect?: RequestRedirect;
	signal?: AbortSignal;
	/** 失败重试次数（仅对网络错误 / 5xx 生效） */
	retries?: number;
	/** Cloudflare 边缘缓存秒数（0 为不缓存） */
	cacheTtl?: number;
};

function linkSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!b) return a;
	const ctrl = new AbortController();
	const abort = () => ctrl.abort();
	if (a.aborted || b.aborted) ctrl.abort();
	a.addEventListener("abort", abort);
	b.addEventListener("abort", abort);
	return ctrl.signal;
}

export async function fetchWithTimeout(url: string, opts: FetchOpts = {}): Promise<Response> {
	const timeoutMs = opts.timeoutMs ?? 8000;
	const retries = Math.max(0, opts.retries ?? 0);
	let lastErr: unknown = new Error("unknown fetch failure");

	for (let attempt = 0; attempt <= retries; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const init: RequestInit = {
				method: opts.method ?? "GET",
				headers: opts.headers ?? upstreamHeaders(url),
				redirect: opts.redirect ?? "follow",
				signal: linkSignals(ctrl.signal, opts.signal),
			};
			if (opts.cacheTtl && opts.cacheTtl > 0) {
				(init as RequestInit & { cf?: Record<string, unknown> }).cf = {
					cacheTtl: opts.cacheTtl,
					cacheEverything: true,
				};
			}
			const res = await fetch(url, init);
			// 5xx 值得重试；4xx 是确定性错误，直接返回
			if (res.status >= 500 && attempt < retries) {
				lastErr = new Error("upstream " + res.status);
				continue;
			}
			return res;
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr;
}

/**
 * 容错 JSON：
 *  - 忽略 content-type（很多采集站返回 text/html 但体是 JSON）
 *  - 去 BOM / 前后缀垃圾（JSONP、调试输出）
 *  - 解析失败返回 null 而不抛错
 */
export function parseJsonLoose<T = Record<string, unknown>>(raw: string): T | null {
	if (!raw) return null;
	let text = raw.replace(/^\uFEFF/, "").trim();
	try {
		return JSON.parse(text) as T;
	} catch {
		/* fallthrough */
	}
	const start = text.search(/[[{]/);
	if (start < 0) return null;
	const endObj = text.lastIndexOf("}");
	const endArr = text.lastIndexOf("]");
	const end = Math.max(endObj, endArr);
	if (end <= start) return null;
	text = text.slice(start, end + 1);
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export async function fetchJson<T = Record<string, unknown>>(
	url: string,
	opts: FetchOpts = {},
): Promise<T | null> {
	try {
		const res = await fetchWithTimeout(url, opts);
		if (!res.ok) return null;
		return parseJsonLoose<T>(await res.text());
	} catch {
		return null;
	}
}
