// 流代理的零依赖单测：SSRF 白/黑名单、HMAC 令牌、m3u8 改写。
// proxy.ts 不 import 任何模块，因此可被 Node 直接加载执行。
// 运行：npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_TOKEN_TTL,
	TokenMinter,
	getProxySecret,
	hostPrefix,
	isLivePlaylist,
	isProxySecretWeak,
	isSafeUpstream,
	looksLikePlaylistType,
	looksLikePlaylistUrl,
	mintToken,
	rewritePlaylist,
	urlPrefix,
	verifyToken,
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

test("getProxySecret：按 STREAM_SECRET → CRON_SECRET → PASSWORD 顺序回退", () => {
	assert.equal(getProxySecret({ STREAM_SECRET: "s", CRON_SECRET: "c", PASSWORD: "p" }), "s");
	assert.equal(getProxySecret({ CRON_SECRET: "c", PASSWORD: "p" }), "c");
	assert.equal(getProxySecret({ PASSWORD: "p" }), "p");
	assert.ok(getProxySecret({}).length > 0);
	assert.equal(isProxySecretWeak({}), true);
	assert.equal(isProxySecretWeak({ STREAM_SECRET: "s" }), false);
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
