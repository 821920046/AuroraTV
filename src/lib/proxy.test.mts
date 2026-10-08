// 流代理的单测：SSRF 白/黑名单、端口白名单、DNS 预解析注入、HMAC 令牌、m3u8 改写。
//
// proxy.ts 只 import 同目录下两个零依赖模块（ipaddr.ts / dnsguard.ts），
// 整条链不碰外部包、不碰 tsconfig 的 paths 别名，因此可被 Node 直接加载执行。
// 运行：npm test
//
// 注意：guardedFetch 默认会做 DoH 预解析，单测必须传 verifyHost: null 关掉它 ——
// 否则每个用例都会真的去查一次外网，测试变慢、变脆且依赖网络。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_TOKEN_TTL,
	INSECURE_DEFAULT_SECRET,
	MAX_REDIRECTS,
	TokenMinter,
	getExplicitSecret,
	guardedFetch,
	hostOf,
	hostPrefix,
	isLivePlaylist,
	isProxySecretWeak,
	isSafeUpstream,
	looksLikePlaylistType,
	looksLikePlaylistUrl,
	mintToken,
	pickSecret,
	rewritePlaylist,
	urlPrefix,
	verifyToken,
	type ProxyEnv,
} from "./proxy.ts";

const SECRET = "unit-test-secret-please-change";

// ---------------------------------------------------------------- SSRF

test("isSafeUpstream：放行普通公网 http(s)", () => {
	assert.equal(isSafeUpstream("https://cdn.example.com/a/b.m3u8"), true);
	assert.equal(isSafeUpstream("http://1.1.1.1/x.ts"), true);
	assert.equal(isSafeUpstream("https://172.32.0.1/x"), true); // 私网段之外
	assert.equal(isSafeUpstream("https://192.169.0.1/x"), true); // 私网段之外
});

test("isSafeUpstream：拒绝回环 / 私网 / CGNAT / 云元数据 / 组播", () => {
	const blocked = [
		"http://127.0.0.1/x",
		"http://127.1.2.3/x",
		"http://0.0.0.0/x",
		"http://10.0.0.5/x",
		"http://172.16.0.1/x",
		"http://172.31.255.255/x",
		"http://192.168.1.1/x",
		"http://100.64.0.1/x",
		"http://100.127.255.255/x",
		"http://169.254.169.254/latest/meta-data/",
		"http://224.0.0.1/x",
		"http://239.1.1.1/x",
	];
	for (const u of blocked) assert.equal(isSafeUpstream(u), false, u);
});

test("isSafeUpstream：拒绝内网主机名与云元数据域名", () => {
	for (const u of [
		"http://localhost/x",
		"http://a.localhost/x",
		"http://foo.internal/x",
		"http://printer.local/x",
		"http://metadata.google.internal/computeMetadata/v1/",
	]) {
		assert.equal(isSafeUpstream(u), false, u);
	}
});

test("isSafeUpstream：拒绝 IPv6 回环 / ULA / 链路本地", () => {
	for (const u of ["http://[::1]/x", "http://[fd00::1]/x", "http://[fc00::1]/x", "http://[fe80::1]/x"]) {
		assert.equal(isSafeUpstream(u), false, u);
	}
});

test("isSafeUpstream：拒绝 IPv4 映射 / 兼容形式的回环（旧正则的漏网之鱼）", () => {
	// WHATWG URL 会把 [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]。
	// 旧实现只比对 "::1" / /^f[cd]xx:/ / /^fe80:/ 三个字符串形态，一个都不命中，
	// 于是「回环地址」被判定为安全 —— 重定向到内网即可绕过整层 SSRF 防护。
	for (const u of [
		"http://[::ffff:127.0.0.1]/x",
		"http://[::ffff:7f00:1]/x",
		"http://[::ffff:169.254.169.254]/latest/meta-data/",
		"http://[::ffff:10.0.0.1]/x",
		"http://[::ffff:192.168.1.1]/x",
		"http://[::ffff:100.64.0.1]/x",
		"http://[::ffff:224.0.0.1]/x",
		"http://[::127.0.0.1]/x",
		"http://[0:0:0:0:0:ffff:7f00:1]/x",
	]) {
		assert.equal(isSafeUpstream(u), false, u);
	}
});

test("isSafeUpstream：拒绝其它 IPv6 危险段", () => {
	for (const u of [
		"http://[::]/x", // 未指定地址
		"http://[0:0:0:0:0:0:0:1]/x", // 展开写法的回环
		"http://[ff02::1]/x", // 链路本地组播
		"http://[64:ff9b::7f00:1]/x", // NAT64 里映射回环
		"http://[2001:0000::1]/x", // Teredo 2001::/32
		"http://[2002:7f00:1::]/x", // 6to4 内嵌 127.0.0.1
		"http://[2002:a00:1::]/x", // 6to4 内嵌 10.0.0.1
		"http://[fe80::1%25eth0]/x", // 带 zone id 的链路本地
	]) {
		assert.equal(isSafeUpstream(u), false, u);
	}
});

test("isSafeUpstream：放行公网 IPv6", () => {
	for (const u of [
		"http://[2001:4860:4860::8888]/x",
		"http://[2606:4700:4700::1111]/x",
		"http://[::ffff:1.1.1.1]/x", // 映射的是公网 v4，应放行
		"http://[2001:db8::1]/x", // 文档段，不是内网
	]) {
		assert.equal(isSafeUpstream(u), true, u);
	}
});

test("isSafeUpstream：拒绝非 http(s) 协议与非法 URL", () => {
	for (const u of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "not a url", ""]) {
		assert.equal(isSafeUpstream(u), false, u);
	}
});

// ---------------------------------------------------------------- 令牌

test("mintToken/verifyToken：正常往返", async () => {
	const target = "https://cdn.example.com/hls/1/2.ts";
	const token = await mintToken(SECRET, urlPrefix(target));
	const v = await verifyToken(SECRET, token, target);
	assert.deepEqual(v, { ok: true });
});

test("verifyToken：前缀绑定 —— 签名不能跨目录复用", async () => {
	const token = await mintToken(SECRET, urlPrefix("https://cdn.example.com/hls/1/2.ts"));
	const v = await verifyToken(SECRET, token, "https://cdn.example.com/other/9.ts");
	assert.equal(v.ok, false);
	assert.equal(v.ok === false && v.reason, "prefix mismatch");
});

test("verifyToken：换密钥即失效", async () => {
	const target = "https://cdn.example.com/a.ts";
	const token = await mintToken(SECRET, urlPrefix(target));
	const v = await verifyToken("another-secret", token, target);
	assert.equal(v.ok === false && v.reason, "bad signature");
});

test("verifyToken：篡改签名被拒", async () => {
	const target = "https://cdn.example.com/a.ts";
	const token = await mintToken(SECRET, urlPrefix(target));
	const parts = token.split(".");
	parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("AA") ? "BB" : "AA");
	const v = await verifyToken(SECRET, parts.join("."), target);
	assert.equal(v.ok === false && v.reason, "bad signature");
});

test("verifyToken：过期令牌被拒", async () => {
	const target = "https://cdn.example.com/a.ts";
	const token = await mintToken(SECRET, urlPrefix(target), -10);
	const v = await verifyToken(SECRET, token, target);
	assert.equal(v.ok === false && v.reason, "token expired");
});

test("verifyToken：缺失 / 结构错误的令牌被拒", async () => {
	const target = "https://cdn.example.com/a.ts";
	assert.equal((await verifyToken(SECRET, null, target)).ok, false);
	assert.equal((await verifyToken(SECRET, "abc", target)).ok, false);
	assert.equal((await verifyToken(SECRET, "x.y.z.w", target)).ok, false);
});

test("verifyToken：即便签名合法，内网目标也必须被 SSRF 拦截", async () => {
	// mintToken 本身不做地址校验，所以可以给内网地址签出合法令牌；
	// verifyToken 必须在这一步把它拦下 —— 这是 SSRF 的最后一道闸。
	const target = "http://169.254.169.254/latest/meta-data/";
	const token = await mintToken(SECRET, urlPrefix(target));
	const v = await verifyToken(SECRET, token, target);
	assert.equal(v.ok === false && v.reason, "blocked upstream");
});

test("urlPrefix / hostPrefix：目录级与站点级前缀", () => {
	assert.equal(urlPrefix("https://c.example.com/a/b/c.ts"), "https://c.example.com/a/b/");
	assert.equal(hostPrefix("https://c.example.com/a/b/c.ts"), "https://c.example.com/");
});

test("getExplicitSecret：只认 STREAM_SECRET / CRON_SECRET，且不认 PASSWORD", () => {
	assert.equal(getExplicitSecret({ STREAM_SECRET: "s", CRON_SECRET: "c" }), "s");
	assert.equal(getExplicitSecret({ CRON_SECRET: "c" }), "c");
	assert.equal(getExplicitSecret({}), null);
	// PASSWORD 是后台登录口令，熵低且职责不同，绝不能当作签名密钥 ——
	// 否则泄漏一个口令就等于泄漏「铸造任意代理令牌」的能力。
	assert.equal(getExplicitSecret({ PASSWORD: "p" } as unknown as ProxyEnv), null);
});

test("pickSecret：显式配置 > D1 持久化密钥 > 公开兜底常量", () => {
	assert.equal(pickSecret("explicit", "persisted"), "explicit");
	assert.equal(pickSecret(null, "persisted"), "persisted");
	assert.equal(pickSecret(null, null), INSECURE_DEFAULT_SECRET);
	assert.equal(pickSecret("", ""), INSECURE_DEFAULT_SECRET);
});

test("isProxySecretWeak：只有回退到公开常量才算无防护", () => {
	assert.equal(isProxySecretWeak(INSECURE_DEFAULT_SECRET), true);
	assert.equal(isProxySecretWeak("a".repeat(64)), false);
	// 兜底常量必须是「人人可见的固定值」这一事实本身：换个名字并不能让它变安全，
	// 因此这里断言它与源码中的字面量一致，避免有人误以为改个常量名就加固了。
	assert.equal(INSECURE_DEFAULT_SECRET, "auroratv-default-insecure-secret");
});

test("DEFAULT_TOKEN_TTL 为 12 小时", () => {
	assert.equal(DEFAULT_TOKEN_TTL, 12 * 60 * 60);
});

// ---------------------------------------------------------------- m3u8 改写

test("rewritePlaylist：分片与子列表改写为同源代理地址", async () => {
	const base = "https://cdn.example.com/hls/index.m3u8";
	const text = [
		"#EXTM3U",
		"#EXT-X-TARGETDURATION:10",
		"#EXTINF:9.9,",
		"seg1.ts",
		"#EXTINF:9.9,",
		"https://other.example.com/abs/seg2.ts",
		"#EXT-X-ENDLIST",
	].join("\n");
	const minter = new TokenMinter(SECRET);
	const out = await rewritePlaylist(text, base, minter);
	const lines = out.split("\n");

	assert.equal(lines[0], "#EXTM3U");
	assert.equal(lines[1], "#EXT-X-TARGETDURATION:10");
	assert.match(lines[3], /^\/api\/stream\?u=https%3A%2F%2Fcdn\.example\.com%2Fhls%2Fseg1\.ts&t=/);
	assert.match(lines[5], /^\/api\/stream\?u=https%3A%2F%2Fother\.example\.com%2Fabs%2Fseg2\.ts&t=/);
	assert.equal(lines[6], "#EXT-X-ENDLIST");
});

test("rewritePlaylist：改写 #EXT-X-KEY / #EXT-X-MAP 的 URI 属性", async () => {
	const base = "https://cdn.example.com/hls/index.m3u8";
	const text = [
		'#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
		'#EXT-X-MAP:URI="https://cdn.example.com/hls/init.mp4"',
		"#EXTINF:4,",
		"a.ts",
	].join("\n");
	const out = await rewritePlaylist(text, base, new TokenMinter(SECRET));
	const lines = out.split("\n");

	assert.match(lines[0], /^#EXT-X-KEY:METHOD=AES-128,URI="\/api\/stream\?u=/);
	assert.match(lines[0], /IV=0x1$/);
	assert.match(lines[1], /^#EXT-X-MAP:URI="\/api\/stream\?u=/);
});

test("rewritePlaylist：不相关的标签与空行原样保留", async () => {
	const base = "https://cdn.example.com/hls/index.m3u8";
	const text = "#EXTM3U\n\n#EXT-X-VERSION:3\n";
	const out = await rewritePlaylist(text, base, new TokenMinter(SECRET));
	assert.equal(out, "#EXTM3U\n\n#EXT-X-VERSION:3\n");
});

test("rewritePlaylist：内网子地址不做改写（避免把代理当内网跳板）", async () => {
	const base = "https://cdn.example.com/hls/index.m3u8";
	const out = await rewritePlaylist("http://127.0.0.1/evil.ts\n", base, new TokenMinter(SECRET));
	assert.equal(out.trim(), "http://127.0.0.1/evil.ts");
});

test("TokenMinter：同一前缀只铸一次令牌（500 片列表只做 1 次 HMAC）", async () => {
	const minter = new TokenMinter(SECRET);
	const a = await minter.streamUrl("https://cdn.example.com/hls/1.ts");
	const b = await minter.streamUrl("https://cdn.example.com/hls/2.ts");
	// u= 不同是应该的（指向不同分片），但 t= 必须完全相同，否则说明每片都重签了一次。
	const tokenOf = (u: string) => new URL(u, "https://x").searchParams.get("t");
	assert.equal(tokenOf(a), tokenOf(b));
	assert.match(a, /^\/api\/stream\?u=/);
});

test("isLivePlaylist：无 ENDLIST 判为直播", () => {
	assert.equal(isLivePlaylist("#EXTM3U\n#EXTINF:5,\na.ts"), true);
	assert.equal(isLivePlaylist("#EXTM3U\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST"), false);
	assert.equal(isLivePlaylist("#EXTM3U\n#EXT-X-ENDLIST"), false);
});

test("looksLikePlaylistUrl / looksLikePlaylistType", () => {
	assert.equal(looksLikePlaylistUrl("https://a/b/index.m3u8"), true);
	assert.equal(looksLikePlaylistUrl("https://a/b/index.m3u8?x=1"), true);
	assert.equal(looksLikePlaylistUrl("https://a/b/seg.ts"), false);
	assert.equal(looksLikePlaylistType("application/vnd.apple.mpegurl"), true);
	assert.equal(looksLikePlaylistType("application/x-mpegURL"), true);
	assert.equal(looksLikePlaylistType("video/mp2t"), false);
	assert.equal(looksLikePlaylistType(null), false);
});

// ---------------------------------------------------------------- 守卫取流

type Call = { url: string; redirect?: RequestRedirect; headers?: Record<string, string> };

/** 造一个按 URL 返回预设响应的假 fetch，并记录每一跳，用于断言「哪些地址真的被请求过」 */
function fakeFetch(script: Record<string, () => Response>, calls: Call[]): typeof fetch {
	return (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		calls.push({
			url,
			redirect: init?.redirect,
			headers: init?.headers as Record<string, string> | undefined,
		});
		const fn = script[url];
		if (!fn) throw new Error("unexpected fetch: " + url);
		return fn();
	}) as unknown as typeof fetch;
}

const redirectTo = (location: string): Response =>
	new Response(null, { status: 302, headers: { location } });

const okBody = (text: string): Response =>
	new Response(text, { status: 200, headers: { "content-type": "text/plain" } });

test("hostOf：保留端口，非法 URL 回退", () => {
	assert.equal(hostOf("https://a.example.com:8443/x"), "a.example.com:8443");
	assert.equal(hostOf("nonsense"), "invalid-url");
});

test("guardedFetch：直连成功时只发一次 manual 请求", async () => {
	const calls: Call[] = [];
	const f = fakeFetch({ "https://cdn.example.com/a.m3u8": () => okBody("hello") }, calls);
	const r = await guardedFetch("https://cdn.example.com/a.m3u8", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.finalUrl, "https://cdn.example.com/a.m3u8");
		assert.equal(await r.res.text(), "hello");
	}
	assert.equal(calls.length, 1);
	assert.equal(calls[0].redirect, "manual");
});

test("guardedFetch：跟随公网 -> 公网重定向，finalUrl 为最终落点", async () => {
	const calls: Call[] = [];
	const f = fakeFetch(
		{
			"https://a.example.com/1.m3u8": () => redirectTo("https://b.example.com/2.m3u8"),
			"https://b.example.com/2.m3u8": () => okBody("done"),
		},
		calls,
	);
	const r = await guardedFetch("https://a.example.com/1.m3u8", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.finalUrl, "https://b.example.com/2.m3u8");
	assert.deepEqual(
		calls.map((c) => c.url),
		["https://a.example.com/1.m3u8", "https://b.example.com/2.m3u8"],
	);
});

test("guardedFetch：公网 302 到内网必须拦下，且内网地址一次都不会被请求（SSRF 重定向绕过）", async () => {
	for (const evil of [
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:8080/admin",
		"http://[::ffff:127.0.0.1]/admin",
		"http://192.168.0.1/",
		"http://localhost/",
	]) {
		const calls: Call[] = [];
		const f = fakeFetch({ "https://evil.example.com/r": () => redirectTo(evil) }, calls);
		const r = await guardedFetch("https://evil.example.com/r", { fetcher: f, verifyHost: null });
		assert.equal(r.ok, false, evil);
		if (!r.ok) assert.match(r.error, /blocked upstream/, evil);
		// 最关键的断言：危险地址从未被真正请求
		assert.equal(calls.length, 1, evil);
		assert.equal(calls[0].url, "https://evil.example.com/r", evil);
	}
});

test("guardedFetch：支持相对 Location", async () => {
	const calls: Call[] = [];
	const f = fakeFetch(
		{
			"https://a.example.com/dir/1.m3u8": () => redirectTo("/dir/2.m3u8"),
			"https://a.example.com/dir/2.m3u8": () => okBody("ok"),
		},
		calls,
	);
	const r = await guardedFetch("https://a.example.com/dir/1.m3u8", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.finalUrl, "https://a.example.com/dir/2.m3u8");
});

test("guardedFetch：请求头按每一跳的域名重新生成", async () => {
	const calls: Call[] = [];
	const f = fakeFetch(
		{
			"https://a.example.com/1": () => redirectTo("https://b.example.com/2"),
			"https://b.example.com/2": () => okBody("x"),
		},
		calls,
	);
	await guardedFetch("https://a.example.com/1", {
		fetcher: f,
		verifyHost: null,
		headers: (u) => ({ referer: new URL(u).origin + "/" }),
	});
	assert.equal(calls[0].headers?.referer, "https://a.example.com/");
	assert.equal(calls[1].headers?.referer, "https://b.example.com/");
});

test("guardedFetch：重定向次数超过上限即报错", async () => {
	const calls: Call[] = [];
	const script: Record<string, () => Response> = {};
	for (let i = 0; i <= MAX_REDIRECTS + 2; i++) {
		script["https://a.example.com/" + i] = () => redirectTo("https://a.example.com/" + (i + 1));
	}
	const f = fakeFetch(script, calls);
	const r = await guardedFetch("https://a.example.com/0", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /too many redirects/);
	assert.equal(calls.length, MAX_REDIRECTS + 1);
});

test("guardedFetch：3xx 缺少 Location 时报错", async () => {
	const calls: Call[] = [];
	const f = fakeFetch({ "https://a.example.com/x": () => new Response(null, { status: 302 }) }, calls);
	const r = await guardedFetch("https://a.example.com/x", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /redirect without location/);
});

test("guardedFetch：起始地址本身就是内网时一次请求都不发", async () => {
	const calls: Call[] = [];
	const f = fakeFetch({}, calls);
	for (const bad of ["http://169.254.169.254/", "http://127.0.0.1/", "file:///etc/passwd", "not a url"]) {
		const r = await guardedFetch(bad, { fetcher: f, verifyHost: null });
		assert.equal(r.ok, false, bad);
	}
	assert.equal(calls.length, 0);
});

test("guardedFetch：遇到 opaqueredirect 时退回 follow，并校验最终落点", async () => {
	// 模拟浏览器语义：manual 只给出不可读的 opaqueredirect，只能 follow 后用 res.url 事后校验
	const f = (async (_input: unknown, init?: RequestInit) => {
		if (init?.redirect === "follow") {
			const res = new Response("landed", { status: 200 });
			Object.defineProperty(res, "url", { value: "http://127.0.0.1/secret" });
			return res;
		}
		return { status: 0, type: "opaqueredirect" } as unknown as Response;
	}) as unknown as typeof fetch;

	const r = await guardedFetch("https://evil.example.com/r", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /blocked redirect target/);
});

test("guardedFetch：opaqueredirect 落到公网地址时放行", async () => {
	const f = (async (_input: unknown, init?: RequestInit) => {
		if (init?.redirect === "follow") {
			const res = new Response("landed", { status: 200 });
			Object.defineProperty(res, "url", { value: "https://cdn.example.com/final.m3u8" });
			return res;
		}
		return { status: 0, type: "opaqueredirect" } as unknown as Response;
	}) as unknown as typeof fetch;

	const r = await guardedFetch("https://evil.example.com/r", { fetcher: f, verifyHost: null });
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.finalUrl, "https://cdn.example.com/final.m3u8");
});

// ---------------------------------------------------------------- 端口白名单

test("isSafeUpstream：放行默认端口与常见备用端口", () => {
	// 默认端口在 WHATWG URL 里会被规范化成空串，必须显式列进白名单
	assert.equal(isSafeUpstream("https://cdn.example.com/a.m3u8"), true);
	assert.equal(isSafeUpstream("https://cdn.example.com:443/a.m3u8"), true);
	assert.equal(isSafeUpstream("http://cdn.example.com:80/a.ts"), true);
	assert.equal(isSafeUpstream("http://cdn.example.com:8080/a.ts"), true);
	assert.equal(isSafeUpstream("https://cdn.example.com:8443/a.ts"), true);
});

test("isSafeUpstream：拒绝非白名单端口（堵死内网端口探测）", () => {
	for (const bad of [
		"http://cdn.example.com:22/",
		"http://cdn.example.com:3306/",
		"http://cdn.example.com:6379/",
		"http://cdn.example.com:9200/",
		"https://cdn.example.com:9000/",
	]) {
		assert.equal(isSafeUpstream(bad), false, bad);
	}
});

test("isSafeUpstream：某段超过 255 的伪 IPv4 按拒绝处理", () => {
	// WHATWG URL 会把这种输入退化成「域名」，随后解析必然失败；
	// 显式拒绝比依赖「反正也连不上」更明确。
	assert.equal(isSafeUpstream("http://999.1.1.1/"), false);
	assert.equal(isSafeUpstream("http://1.2.3.999/"), false);
});

// ---------------------------------------------------------------- DNS 预解析

test("guardedFetch：注入的 verifyHost 逐跳调用，判为危险时在发请求前拦下", async () => {
	const calls: Call[] = [];
	const f = fakeFetch(
		{
			"https://a.example.com/1": () => redirectTo("https://b.example.com/2"),
			"https://b.example.com/2": () => okBody("x"),
		},
		calls,
	);
	const seen: string[] = [];
	const r = await guardedFetch("https://a.example.com/1", {
		fetcher: f,
		verifyHost: async (h) => {
			seen.push(h);
			return h !== "b.example.com"; // 第二跳的域名被判为危险
		},
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /blocked upstream \(dns\)/);
	// 两跳的域名都被校验过，但第二个危险地址一次都没被真正请求
	assert.deepEqual(seen, ["a.example.com", "b.example.com"]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://a.example.com/1");
});

test("guardedFetch：verifyHost 收到的是纯主机名（无端口、无方括号）", async () => {
	const calls: Call[] = [];
	const f = fakeFetch({ "https://a.example.com:8443/x": () => okBody("x") }, calls);
	const seen: string[] = [];
	await guardedFetch("https://a.example.com:8443/x", {
		fetcher: f,
		verifyHost: async (h) => {
			seen.push(h);
			return true;
		},
	});
	assert.deepEqual(seen, ["a.example.com"]);
});

test("guardedFetch：默认即启用 DNS 校验，IP 字面量会被短路跳过", async () => {
	// 这条刻意不传 verifyHost，用来锁住「默认是开启的」这个行为。
	// 用 IP 字面量是为了让 dnsguard 直接短路返回，全程不产生任何网络请求。
	const calls: Call[] = [];
	const f = fakeFetch({ "http://1.1.1.1/x.ts": () => okBody("x") }, calls);
	const r = await guardedFetch("http://1.1.1.1/x.ts", { fetcher: f });
	assert.equal(r.ok, true);
	assert.equal(calls.length, 1);
});
