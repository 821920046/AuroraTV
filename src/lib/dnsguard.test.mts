import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	__dnsCacheSize,
	__resetDnsCache,
	verifyHostResolvesPublic,
} from "./dnsguard.ts";

// ---------------------------------------------------------------- 测试脚手架

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	__resetDnsCache();
});

type Answer = { type: number; data: string };

function dohOk(answers: Answer[]): Response {
	return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
		headers: { "content-type": "application/dns-json" },
	});
}

function dohStatus(status: number): Response {
	return new Response(JSON.stringify({ Status: status }), {
		headers: { "content-type": "application/dns-json" },
	});
}

/**
 * 装一个假的 DoH 服务端。
 * handler 返回 Response 表示查询成功；抛异常表示网络层失败（与「查到了但没有记录」区分开）。
 */
function installDoh(
	handler: (host: string, type: string) => Response | Promise<Response>,
): () => number {
	let calls = 0;
	globalThis.fetch = (async (input: unknown) => {
		calls += 1;
		const u = new URL(String(input));
		return handler(u.searchParams.get("name") ?? "", u.searchParams.get("type") ?? "");
	}) as unknown as typeof fetch;
	return () => calls;
}

// ---------------------------------------------------------------- 正常路径

test("解析到公网 A 记录 -> 放行", async () => {
	installDoh((_h, type) => (type === "A" ? dohOk([{ type: 1, data: "93.184.216.34" }]) : dohOk([])));
	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
});

test("解析到 IPv6 公网地址 -> 放行", async () => {
	installDoh((_h, type) =>
		type === "AAAA" ? dohOk([{ type: 28, data: "2606:4700::1" }]) : dohOk([]),
	);
	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
});

test("多记录里只要有一条内网地址就拒绝（DNS 轮询不能成为绕过口）", async () => {
	installDoh((_h, type) =>
		type === "A"
			? dohOk([
					{ type: 1, data: "93.184.216.34" },
					{ type: 1, data: "127.0.0.1" },
				])
			: dohOk([]),
	);
	assert.equal(await verifyHostResolvesPublic("mixed.example.com"), false);
});

// ---------------------------------------------------------------- 拦截

test("解析到回环 / 私网 / 云元数据 -> 拒绝（DNS rebinding 的核心场景）", async () => {
	for (const evil of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "172.16.0.1"]) {
		__resetDnsCache();
		installDoh((_h, type) => (type === "A" ? dohOk([{ type: 1, data: evil }]) : dohOk([])));
		assert.equal(await verifyHostResolvesPublic("evil.example.com"), false, evil);
	}
});

test("解析到 ULA / 链路本地 IPv6 -> 拒绝", async () => {
	for (const evil of ["fc00::1", "fe80::1", "::1"]) {
		__resetDnsCache();
		installDoh((_h, type) => (type === "AAAA" ? dohOk([{ type: 28, data: evil }]) : dohOk([])));
		assert.equal(await verifyHostResolvesPublic("evil.example.com"), false, evil);
	}
});

test("域名完全不解析（无 A / 无 AAAA）-> 拒绝", async () => {
	installDoh(() => dohStatus(3)); // NXDOMAIN
	assert.equal(await verifyHostResolvesPublic("nxdomain.example.com"), false);
});

test("Answer 里的 CNAME 记录不会被误判成 IP", async () => {
	// CNAME 的 data 是域名。若不过滤 type，它会被当成「解析不出的 IP」而误拒。
	installDoh((_h, type) =>
		type === "A"
			? dohOk([
					{ type: 5, data: "cdn.example.com" }, // CNAME
					{ type: 1, data: "93.184.216.34" }, // 真正的 A
				])
			: dohOk([]),
	);
	assert.equal(await verifyHostResolvesPublic("www.example.com"), true);
});

// ---------------------------------------------------------------- fail-open

test("DoH 网络层失败 -> 放行（fail-open，可用性优先）", async () => {
	installDoh(() => {
		throw new Error("network down");
	});
	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
});

test("DoH 返回非 2xx -> 放行", async () => {
	installDoh(() => new Response("nope", { status: 500 }));
	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
});

test("DoH 返回非法 JSON -> 放行", async () => {
	installDoh(() => new Response("<<not json>>", { status: 200 }));
	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
});

// ---------------------------------------------------------------- 缓存

test("同一主机第二次判定不再发起任何查询（缓存生效）", async () => {
	const calls = installDoh((_h, type) =>
		type === "A" ? dohOk([{ type: 1, data: "93.184.216.34" }]) : dohOk([]),
	);
	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
	const afterFirst = calls();
	assert.ok(afterFirst > 0, "首次必须真的查一次");

	assert.equal(await verifyHostResolvesPublic("cdn.example.com"), true);
	assert.equal(calls(), afterFirst, "第二次不该再发请求");
});

test("拒绝结果同样被缓存（避免被反复触发查询）", async () => {
	const calls = installDoh((_h, type) =>
		type === "A" ? dohOk([{ type: 1, data: "127.0.0.1" }]) : dohOk([]),
	);
	assert.equal(await verifyHostResolvesPublic("evil.example.com"), false);
	const afterFirst = calls();
	assert.equal(await verifyHostResolvesPublic("evil.example.com"), false);
	assert.equal(calls(), afterFirst);
});

test("同一 host 的并发查询被合并成一次（否则一个搜索页会打出上百次 DoH）", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let calls = 0;
	globalThis.fetch = (async (input: unknown) => {
		calls += 1;
		await gate; // 卡住所有查询，确保三个调用真的并发
		const u = new URL(String(input));
		return u.searchParams.get("type") === "A"
			? dohOk([{ type: 1, data: "93.184.216.34" }])
			: dohOk([]);
	}) as unknown as typeof fetch;

	const all = Promise.all([
		verifyHostResolvesPublic("cdn.example.com"),
		verifyHostResolvesPublic("cdn.example.com"),
		verifyHostResolvesPublic("cdn.example.com"),
	]);
	release();
	assert.deepEqual(await all, [true, true, true]);
	// 只应有 A + AAAA 两次查询，而不是 3 × 2 = 6 次
	assert.equal(calls, 2);
});

test("不同主机各自缓存，不会串键", async () => {
	installDoh((_h, type) =>
		type === "A"
			? dohOk([{ type: 1, data: _h.startsWith("evil") ? "127.0.0.1" : "93.184.216.34" }])
			: dohOk([]),
	);
	assert.equal(await verifyHostResolvesPublic("good.example.com"), true);
	assert.equal(await verifyHostResolvesPublic("evil.example.com"), false);
	assert.equal(await verifyHostResolvesPublic("good.example.com"), true);
	assert.equal(__dnsCacheSize() >= 2, true);
});

// ---------------------------------------------------------------- 短路

test("IP 字面量直接短路：不发任何 DoH 查询", async () => {
	const calls = installDoh(() => dohOk([]));
	assert.equal(await verifyHostResolvesPublic("1.1.1.1"), true);
	assert.equal(await verifyHostResolvesPublic("[::1]"), true);
	assert.equal(calls(), 0, "IP 字面量不该触发 DNS 查询");
});

test("主机名大小写与方括号被归一化", async () => {
	const seen: string[] = [];
	installDoh((host, type) => {
		seen.push(host);
		return type === "A" ? dohOk([{ type: 1, data: "93.184.216.34" }]) : dohOk([]);
	});
	await verifyHostResolvesPublic("  CDN.Example.COM  ");
	// 归一化后的名字才会被拿去查询（DoH 服务端本来也大小写不敏感）
	assert.ok(seen.every((h) => h === "cdn.example.com"), seen.join(","));
});

test("空主机名直接拒绝，不发查询", async () => {
	const calls = installDoh(() => dohOk([]));
	assert.equal(await verifyHostResolvesPublic(""), false);
	assert.equal(calls(), 0);
});
