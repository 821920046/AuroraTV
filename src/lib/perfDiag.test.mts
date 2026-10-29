import test from "node:test";
import assert from "node:assert/strict";
import { fmtBytes, kindOf, percentile, summarize, verdictOf, type Entry } from "./perfDiag.ts";

/** 造一条可用的资源记录。ttfb/down 直接给毫秒，内部换算成时间戳。 */
function entry(
	name: string,
	ttfb: number,
	down = 10,
	opts: { transferSize?: number; upstream?: number } = {},
): Entry {
	const requestStart = 1000;
	const responseStart = requestStart + ttfb;
	return {
		name,
		requestStart,
		responseStart,
		responseEnd: responseStart + down,
		transferSize: opts.transferSize ?? 50000,
		serverTiming:
			opts.upstream === undefined ? undefined : [{ name: "upstream", duration: opts.upstream }],
	};
}

test("kindOf：只认两条热点链路", () => {
	assert.equal(kindOf("https://a.com/api/img?u=x&t=y"), "img");
	assert.equal(kindOf("https://a.com/api/stream?u=x&t=y"), "stream");
	assert.equal(kindOf("/api/img?u=x"), "img", "相对地址也要能判");
	assert.equal(kindOf("https://a.com/api/search?wd=x"), null);
	assert.equal(kindOf("https://a.com/api/imgx"), null, "前缀相同但不是该端点");
	assert.equal(kindOf("not a url"), null);
});

test("percentile：空数组与边界", () => {
	assert.equal(percentile([], 0.5), 0);
	assert.equal(percentile([7], 0.5), 7);
	assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
	assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
	// p 越界要夹紧，不能返回 undefined
	assert.equal(percentile([1, 2, 3], 9), 3);
	assert.equal(percentile([1, 2, 3], -9), 1);
});

test("summarize：按链路分组并算出 TTFB / 下载 / 上游", () => {
	const rows = summarize([
		entry("https://a.com/api/img?u=1", 400, 60, { upstream: 380 }),
		entry("https://a.com/api/img?u=2", 600, 40, { upstream: 560 }),
		entry("https://a.com/api/stream?u=a.ts", 120, 20, { upstream: 100 }),
		entry("https://a.com/api/search?wd=x", 999),
	]);
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => r.kind),
		["img", "stream"],
		"顺序固定，不随数据抖动",
	);

	const img = rows[0];
	assert.equal(img.n, 2);
	// percentile 取「下中位」：偶数个时返回较小的那个，不取两数平均。
	// 性能诊断宁可低估也不要高估，所以刻意这么实现。
	assert.equal(img.ttfbP50, 400, "400 与 600 的下中位是 400");
	assert.equal(img.ttfbMax, 600);
	assert.equal(img.downP50, 40, "下载 60 与 40 的下中位是 40");
	assert.equal(img.upstreamP50, 380, "上游 380 与 560 的下中位是 380");
	assert.equal(img.cached, 0);
	assert.equal(img.bytes, 100000);
});

test("summarize：缓存命中的请求不计字节", () => {
	const rows = summarize([
		entry("https://a.com/api/img?u=1", 2, 0, { transferSize: 0 }),
		entry("https://a.com/api/img?u=2", 4, 0, { transferSize: 0 }),
	]);
	assert.equal(rows[0].cached, 2);
	assert.equal(rows[0].bytes, 0);
});

test("summarize：跨域拿不到分段数据的记录要跳过，不能算成负 TTFB", () => {
	const broken: Entry = {
		name: "https://a.com/api/img?u=x",
		requestStart: 0,
		responseStart: 0,
		responseEnd: 0,
		transferSize: 0,
	};
	const rows = summarize([broken, entry("https://a.com/api/img?u=y", 300)]);
	assert.equal(rows[0].n, 1, "只统计可用的那条");
	assert.equal(rows[0].ttfbP50, 300);
});

test("summarize：没有 server-timing 时 upstreamP50 为 null", () => {
	const rows = summarize([entry("https://a.com/api/img?u=x", 300)]);
	assert.equal(rows[0].upstreamP50, null);
});

test("summarize：没有任何热点请求时返回空数组", () => {
	assert.deepEqual(summarize([]), []);
	assert.deepEqual(summarize([entry("https://a.com/api/search?wd=x", 100)]), []);
});

test("verdictOf：多数命中缓存时不能给出误导性结论", () => {
	const rows = summarize([
		entry("https://a.com/api/img?u=1", 3, 0, { transferSize: 0 }),
		entry("https://a.com/api/img?u=2", 5, 0, { transferSize: 0 }),
		entry("https://a.com/api/img?u=3", 900, 40, { upstream: 850 }),
	]);
	assert.equal(verdictOf(rows[0]).tone, "ok");
	assert.match(verdictOf(rows[0]).text, /缓存/);
});

test("verdictOf：回源占大头时指向上游", () => {
	const rows = summarize([entry("https://a.com/api/img?u=x", 1200, 50, { upstream: 1150 })]);
	const v = verdictOf(rows[0]);
	assert.equal(v.tone, "bad");
	assert.match(v.text, /回源/);
});

test("verdictOf：TTFB 高但回源占比低时指向 Worker 自身", () => {
	const rows = summarize([entry("https://a.com/api/img?u=x", 1200, 50, { upstream: 100 })]);
	const v = verdictOf(rows[0]);
	assert.equal(v.tone, "warn");
	assert.match(v.text, /Worker/);
});

test("verdictOf：单次不慢但超过 300ms 时提示并发排队", () => {
	const rows = summarize([entry("https://a.com/api/img?u=x", 400, 30, { upstream: 380 })]);
	assert.match(verdictOf(rows[0]).text, /并发/);
});

test("verdictOf：拿不到 server-timing 时如实说无法归因", () => {
	const rows = summarize([entry("https://a.com/api/img?u=x", 900)]);
	const v = verdictOf(rows[0]);
	assert.equal(v.tone, "warn");
	assert.match(v.text, /server-timing/);
});

test("verdictOf：健康区间", () => {
	const rows = summarize([entry("https://a.com/api/img?u=x", 120, 20, { upstream: 100 })]);
	assert.equal(verdictOf(rows[0]).tone, "ok");
});

test("fmtBytes：单位换算", () => {
	assert.equal(fmtBytes(0), "0");
	assert.equal(fmtBytes(-5), "0");
	assert.equal(fmtBytes(512), "512 B");
	assert.equal(fmtBytes(2048), "2 KB");
	assert.equal(fmtBytes(3 * 1024 * 1024), "3.0 MB");
});
