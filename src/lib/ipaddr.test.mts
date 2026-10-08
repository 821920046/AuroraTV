import { test } from "node:test";
import assert from "node:assert/strict";
import {
	blockedIpLiteral,
	isBlockedIpv6,
	isIpLiteralHost,
	isPublicIpv4,
	parseIpv4,
	parseIpv6,
} from "./ipaddr.ts";

// ---------------------------------------------------------------- IPv4

test("parseIpv4：合法四段返回数字数组，非法返回 null", () => {
	assert.deepEqual(parseIpv4("1.2.3.4"), [1, 2, 3, 4]);
	assert.deepEqual(parseIpv4("0.0.0.0"), [0, 0, 0, 0]);
	assert.equal(parseIpv4("1.2.3"), null);
	assert.equal(parseIpv4("1.2.3.4.5"), null);
	assert.equal(parseIpv4("a.b.c.d"), null);
	assert.equal(parseIpv4("example.com"), null);
	// 段位越界：是「看起来像 IPv4」，但不是合法 IPv4
	assert.equal(parseIpv4("999.1.1.1"), null);
	assert.equal(parseIpv4("1.2.3.999"), null);
});

test("isPublicIpv4：放行公网段", () => {
	assert.equal(isPublicIpv4(1, 1), true);
	assert.equal(isPublicIpv4(8, 8), true);
	assert.equal(isPublicIpv4(172, 32), true); // 私网段 172.16-31 之外
	assert.equal(isPublicIpv4(192, 169), true); // 私网段 192.168 之外
	assert.equal(isPublicIpv4(100, 63), true); // CGNAT 100.64-127 之外
	assert.equal(isPublicIpv4(223, 255), true); // 组播 224 之前
});

test("isPublicIpv4：拒绝未指定 / 私网 / 回环 / 链路本地 / CGNAT / 保留 / 组播", () => {
	const blocked: Array<[number, number]> = [
		[0, 0], // 未指定
		[10, 0], // 私网
		[127, 0], // 回环
		[169, 254], // 链路本地（云元数据）
		[172, 16], // 私网下界
		[172, 31], // 私网上界
		[192, 168], // 私网
		[100, 64], // CGNAT 下界
		[100, 127], // CGNAT 上界
		[192, 0], // 协议保留
		[198, 18], // 基准测试
		[198, 19], // 基准测试
		[224, 0], // 组播
		[255, 255], // 广播
	];
	for (const [a, b] of blocked) {
		assert.equal(isPublicIpv4(a, b), false, `${a}.${b}.x.x`);
	}
});

// ---------------------------------------------------------------- IPv6

test("parseIpv6：完整形式、压缩形式、内嵌 IPv4 都能展开成 8 组", () => {
	assert.deepEqual(parseIpv6("2001:db8:0:0:0:0:0:1"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual(parseIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual(parseIpv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
	assert.deepEqual(parseIpv6("fe80::1"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
	// 尾部内嵌 IPv4：::ffff:127.0.0.1 -> 最后两组是 7f00 和 0001
	assert.deepEqual(parseIpv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
	// 去掉 zone id
	assert.deepEqual(parseIpv6("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
});

test("parseIpv6：非法输入返回 null", () => {
	assert.equal(parseIpv6("1::2::3"), null);
	assert.equal(parseIpv6("gggg::1"), null);
	assert.equal(parseIpv6("1:2:3"), null); // 没有 :: 时必须正好 8 组
	assert.equal(parseIpv6("::1:2:3:4:5:6:7:8:9"), null); // 超出 8 组
});

test("isBlockedIpv6：拒绝回环 / 未指定 / ULA / 链路本地 / 组播 / NAT64 / Teredo", () => {
	for (const bad of [
		"::",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"ff02::1",
		"64:ff9b::1",
		"2001:0000::1",
	]) {
		assert.equal(isBlockedIpv6(bad), true, bad);
	}
});

test("isBlockedIpv6：IPv4 映射 / 兼容形式按内嵌的 v4 判定（旧正则的漏网之鱼）", () => {
	// 这是上一轮修复的核心：URL 解析器会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1，
	// 字符串前缀比对一个都命中不了，必须按位展开才能发现它是回环地址。
	assert.equal(isBlockedIpv6("::ffff:7f00:1"), true); // ::ffff:127.0.0.1
	assert.equal(isBlockedIpv6("::ffff:127.0.0.1"), true);
	assert.equal(isBlockedIpv6("::ffff:a00:1"), true); // ::ffff:10.0.0.1
	assert.equal(isBlockedIpv6("::ffff:a9fe:a9fe"), true); // ::ffff:169.254.169.254
	// 公网内嵌 v4 应当放行
	assert.equal(isBlockedIpv6("::ffff:101:101"), false); // ::ffff:1.1.1.1
	assert.equal(isBlockedIpv6("::ffff:808:808"), false); // ::ffff:8.8.8.8
});

test("isBlockedIpv6：6to4 按内嵌 v4 判定，公网 IPv6 放行", () => {
	assert.equal(isBlockedIpv6("2002:7f00:1::"), true); // 2002::/16 内嵌 127.0.0.1
	assert.equal(isBlockedIpv6("2002:101:101::"), false); // 内嵌 1.1.1.1
	assert.equal(isBlockedIpv6("2001:db8::1"), false);
	assert.equal(isBlockedIpv6("2606:4700::1"), false);
});

test("isBlockedIpv6：解析失败一律视为危险", () => {
	assert.equal(isBlockedIpv6("not-an-ip"), true);
	assert.equal(isBlockedIpv6(""), true);
});

// ---------------------------------------------------------------- 三态判定

test("blockedIpLiteral：三态语义 —— true 危险 / false 安全 / null 不是 IP", () => {
	// true：明确的危险地址
	assert.equal(blockedIpLiteral("127.0.0.1"), true);
	assert.equal(blockedIpLiteral("10.0.0.1"), true);
	assert.equal(blockedIpLiteral("169.254.169.254"), true);
	assert.equal(blockedIpLiteral("::1"), true);
	assert.equal(blockedIpLiteral("[::ffff:7f00:1]"), true);

	// false：明确的公网地址
	assert.equal(blockedIpLiteral("1.1.1.1"), false);
	assert.equal(blockedIpLiteral("8.8.8.8"), false);
	assert.equal(blockedIpLiteral("2606:4700::1"), false);

	// null：压根不是 IP 字面量 —— 调用方必须走另一条分支（DNS 解析）
	assert.equal(blockedIpLiteral("example.com"), null);
	assert.equal(blockedIpLiteral("cdn.example.com"), null);
	assert.equal(blockedIpLiteral("localhost"), null);
});

test("blockedIpLiteral：形似 IPv4 但段位越界 -> 拒绝而不是放行", () => {
	assert.equal(blockedIpLiteral("999.1.1.1"), true);
	assert.equal(blockedIpLiteral("1.2.3.999"), true);
});

test("blockedIpLiteral：容忍带方括号的 IPv6 写法", () => {
	assert.equal(blockedIpLiteral("[::1]"), true);
	assert.equal(blockedIpLiteral("[2606:4700::1]"), false);
});

test("isIpLiteralHost：区分 IP 字面量与域名", () => {
	assert.equal(isIpLiteralHost("1.1.1.1"), true);
	assert.equal(isIpLiteralHost("::1"), true);
	assert.equal(isIpLiteralHost("[::1]"), true);
	assert.equal(isIpLiteralHost("example.com"), false);
	assert.equal(isIpLiteralHost("localhost"), false);
	// 段位越界 -> 不是合法 IPv4 字面量，会被当成域名（随后解析必然失败）
	assert.equal(isIpLiteralHost("999.1.1.1"), false);
});
