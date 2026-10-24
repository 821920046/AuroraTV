import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CLIENT_ID_COOKIE,
	RATE_RULES,
	bucketOf,
	checkRateLimit,
	clientIdCookie,
	clientIp,
	decide,
	newClientId,
	rateIdentity,
	rateKey,
	readCookie,
	windowIndex,
	type MinimalCache,
} from "./ratelimit.ts";

// ---------------------------------------------------------------- 假 Cache

/** 内存版 Cache：只实现本模块用到的 match/put，行为与 Cache API 对齐（命中返回 Response）。 */
function fakeCache(): MinimalCache & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async match(req: Request) {
			const v = store.get(req.url);
			return v === undefined ? null : new Response(v);
		},
		async put(req: Request, res: Response) {
			store.set(req.url, await res.text());
		},
	};
}

function req(path: string, ip = "1.2.3.4"): Request {
	return new Request("https://auroratv.example" + path, {
		headers: { "cf-connecting-ip": ip },
	});
}

/** 带（或不带）客户端标识 cookie 的请求 —— 模拟 CGNAT 下的多个用户。 */
function reqCid(path: string, ip: string, cid: string | null): Request {
	const headers: Record<string, string> = { "cf-connecting-ip": ip };
	if (cid) headers.cookie = CLIENT_ID_COOKIE + "=" + cid;
	return new Request("https://auroratv.example" + path, { headers });
}

// ---------------------------------------------------------------- 纯逻辑

test("bucketOf：已知端点映射到对应桶", () => {
	assert.equal(bucketOf("/api/stream"), "stream");
	assert.equal(bucketOf("/api/img"), "img");
	assert.equal(bucketOf("/api/search"), "search");
	assert.equal(bucketOf("/api/play"), "play");
	assert.equal(bucketOf("/api/detail"), "detail");
	assert.equal(bucketOf("/api/home"), "home");
	assert.equal(bucketOf("/api/sources"), "sources");
});

test("bucketOf：直播子路由共用 live 桶，末尾斜杠被归一化", () => {
	assert.equal(bucketOf("/api/live/channels"), "live");
	assert.equal(bucketOf("/api/live/play"), "live");
	assert.equal(bucketOf("/api/live/epg"), "live");
	assert.equal(bucketOf("/api/stream/"), "stream");
});

test("bucketOf：后台 / cron / 非 API 路径不参与限流", () => {
	assert.equal(bucketOf("/api/admin/import"), null);
	assert.equal(bucketOf("/api/cron/health"), null);
	assert.equal(bucketOf("/api/health"), null);
	assert.equal(bucketOf("/"), null);
	assert.equal(bucketOf("/live"), null);
});

test("bucketOf：前缀相近的路径不会被误判", () => {
	// /api/searchx 不是 /api/search，也不该命中任何桶
	assert.equal(bucketOf("/api/searchx"), null);
	assert.equal(bucketOf("/api/streamx"), null);
	// /api/lives 同理（startsWith("/api/live/") 要求带斜杠）
	assert.equal(bucketOf("/api/lives"), null);
});

test("windowIndex：同一窗口内恒定，跨窗口 +1", () => {
	const w = 60;
	// 窗口 60s = 60000ms，边界必须取整倍数，否则断言本身就是错的
	const start = 960_000; // 正好是窗口 16 的起点
	assert.equal(windowIndex(start, w), 16);
	assert.equal(windowIndex(start, w), windowIndex(start + 59_999, w));
	assert.equal(windowIndex(start + 60_000, w), 17);
});

test("windowIndex：非法输入不抛异常", () => {
	assert.equal(windowIndex(Number.NaN, 60), 0);
	assert.equal(windowIndex(1000, 0), 0);
	assert.equal(windowIndex(1000, -1), 0);
});

test("decide：未达限额放行并自增", () => {
	assert.deepEqual(decide(0, 3), { allowed: true, next: 1 });
	assert.deepEqual(decide(2, 3), { allowed: true, next: 3 });
});

test("decide：达到限额后拒绝，且不继续自增（避免计数无限增长）", () => {
	assert.deepEqual(decide(3, 3), { allowed: false, next: 3 });
	assert.deepEqual(decide(99, 3), { allowed: false, next: 99 });
});

test("decide：脏计数按 0 处理", () => {
	// 负数、NaN、小数都可能来自被投毒或被截断的 cache 值
	assert.deepEqual(decide(-5, 3), { allowed: true, next: 1 });
	assert.deepEqual(decide(Number.NaN, 3), { allowed: true, next: 1 });
	assert.deepEqual(decide(1.9, 3), { allowed: true, next: 2 });
});

test("rateKey：含 bucket、窗口、IP，且不同维度互不串键", () => {
	const a = rateKey("stream", 10, "1.1.1.1");
	assert.notEqual(a, rateKey("img", 10, "1.1.1.1"));
	assert.notEqual(a, rateKey("stream", 11, "1.1.1.1"));
	assert.notEqual(a, rateKey("stream", 10, "2.2.2.2"));
	assert.equal(a, rateKey("stream", 10, "1.1.1.1"));
});

test("clientIp：cf-connecting-ip 优先，伪造的 x-forwarded-for 不会覆盖它", () => {
	const r = new Request("https://x/", {
		headers: {
			"cf-connecting-ip": "9.9.9.9",
			"x-real-ip": "8.8.8.8",
			"x-forwarded-for": "7.7.7.7, 6.6.6.6",
		},
	});
	assert.equal(clientIp(r), "9.9.9.9");
});

test("clientIp：无 cf 头时依次回退，全无则 unknown", () => {
	const real = new Request("https://x/", { headers: { "x-real-ip": "8.8.8.8" } });
	assert.equal(clientIp(real), "8.8.8.8");

	const xff = new Request("https://x/", {
		headers: { "x-forwarded-for": "7.7.7.7, 6.6.6.6" },
	});
	assert.equal(clientIp(xff), "7.7.7.7");

	assert.equal(clientIp(new Request("https://x/")), "unknown");
});

// ---------------------------------------------------------------- 限流主流程

test("checkRateLimit：限额内放行，第 limit+1 次拒绝", async () => {
	const cache = fakeCache();
	const rule = RATE_RULES.search;
	const deps = { cache, nowMs: 1_700_000_000_000 };

	for (let i = 0; i < rule.limit; i++) {
		const r = await checkRateLimit(req("/api/search"), deps);
		assert.equal(r.limited, false, `第 ${i + 1} 次应放行`);
	}

	const blocked = await checkRateLimit(req("/api/search"), deps);
	assert.equal(blocked.limited, true);
	if (blocked.limited) {
		assert.equal(blocked.bucket, "search");
		assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= rule.windowSec);
	}
});

test("checkRateLimit：跨窗口后计数重置", async () => {
	const cache = fakeCache();
	const rule = RATE_RULES.search;
	const t0 = 1_700_000_000_000;

	for (let i = 0; i < rule.limit; i++) {
		await checkRateLimit(req("/api/search"), { cache, nowMs: t0 });
	}
	assert.equal((await checkRateLimit(req("/api/search"), { cache, nowMs: t0 })).limited, true);

	// 进入下一个窗口：窗口序号变了 -> key 变了 -> 计数归零
	const t1 = t0 + rule.windowSec * 1000;
	assert.equal((await checkRateLimit(req("/api/search"), { cache, nowMs: t1 })).limited, false);
});

test("checkRateLimit：不同 IP 独立计数", async () => {
	const cache = fakeCache();
	const rule = RATE_RULES.search;
	const nowMs = 1_700_000_000_000;

	for (let i = 0; i < rule.limit; i++) {
		await checkRateLimit(req("/api/search", "1.1.1.1"), { cache, nowMs });
	}
	assert.equal(
		(await checkRateLimit(req("/api/search", "1.1.1.1"), { cache, nowMs })).limited,
		true,
	);
	// 换一个 IP 完全不受影响
	assert.equal(
		(await checkRateLimit(req("/api/search", "2.2.2.2"), { cache, nowMs })).limited,
		false,
	);
});

test("checkRateLimit：不同端点各自独立计数", async () => {
	const cache = fakeCache();
	const nowMs = 1_700_000_000_000;

	for (let i = 0; i < RATE_RULES.search.limit; i++) {
		await checkRateLimit(req("/api/search"), { cache, nowMs });
	}
	assert.equal((await checkRateLimit(req("/api/search"), { cache, nowMs })).limited, true);
	// search 打满了，play 不该受影响
	assert.equal((await checkRateLimit(req("/api/play"), { cache, nowMs })).limited, false);
});

// ---------------------------------------------------------------- CGNAT

test("rateIdentity：有 cookie 时是 ip|cid，没有时退回纯 IP", () => {
	assert.equal(rateIdentity(reqCid("/api/search", "1.2.3.4", "abc")), "1.2.3.4|abc");
	assert.equal(rateIdentity(reqCid("/api/search", "1.2.3.4", null)), "1.2.3.4");
});

test("readCookie：只在同名键上命中，空值与畸形片段被忽略", () => {
	const mk = (c: string | null) =>
		new Request("https://x.example/", { headers: c ? { cookie: c } : {} });
	assert.equal(readCookie(mk("aurora_cid=u1"), CLIENT_ID_COOKIE), "u1");
	assert.equal(readCookie(mk("a=1; aurora_cid=u2; b=3"), CLIENT_ID_COOKIE), "u2");
	assert.equal(readCookie(mk("other=u3"), CLIENT_ID_COOKIE), null);
	assert.equal(readCookie(mk("aurora_cid="), CLIENT_ID_COOKIE), null);
	assert.equal(readCookie(mk("aurora_cid"), CLIENT_ID_COOKIE), null);
	assert.equal(readCookie(mk(null), CLIENT_ID_COOKIE), null);
});

test("clientIdCookie：带 Path/Max-Age/SameSite，https 时才加 Secure", () => {
	const v = clientIdCookie("u1", true);
	assert.ok(v.startsWith(CLIENT_ID_COOKIE + "=u1;"));
	assert.ok(v.includes("Path=/"));
	assert.ok(v.includes("SameSite=Lax"));
	assert.ok(v.includes("Max-Age=31536000"));
	assert.ok(v.includes("Secure"), "https 下必须带 Secure");
	assert.ok(!clientIdCookie("u1", false).includes("Secure"), "http 下不能带 Secure");
});

test("newClientId：两次生成不相同且非空", () => {
	const a = newClientId();
	const b = newClientId();
	assert.ok(a.length > 0);
	assert.notEqual(a, b);
});

test("checkRateLimit：CGNAT 下同一 IP 的不同客户端互不挤占", async () => {
	// 这正是手机上「明明没怎么用却一直 429」的复现场景：
	// 一个共享出口 IP 底下的多个用户，改造前会互相把限额烧光。
	const cache = fakeCache();
	const rule = RATE_RULES.search;
	const nowMs = 1_700_000_000_000;
	const nat = "203.0.113.9"; // CGNAT 共享出口

	for (let i = 0; i < rule.limit; i++) {
		await checkRateLimit(reqCid("/api/search", nat, "user-a"), { cache, nowMs });
	}
	// user-a 已经打满
	assert.equal(
		(await checkRateLimit(reqCid("/api/search", nat, "user-a"), { cache, nowMs })).limited,
		true,
	);
	// 同一出口下的 user-b 完全不受影响 —— 改造前这里会被误杀
	assert.equal(
		(await checkRateLimit(reqCid("/api/search", nat, "user-b"), { cache, nowMs })).limited,
		false,
	);
});

test("checkRateLimit：换 cookie 不能绕开 IP 维度（IP 仍在键里）", async () => {
	// 防的是「脚本靠不断换 ID 无限刷」：每个新 ID 都是新桶，看似绕过了，
	// 但 IP 段仍在键中，配合边缘限流仍可识别。这里至少保证行为是可预期的：
	// 同一 IP + 同一 cid 才会累计。
	const cache = fakeCache();
	const nowMs = 1_700_000_000_000;
	await checkRateLimit(reqCid("/api/search", "1.2.3.4", "u1"), { cache, nowMs });
	await checkRateLimit(reqCid("/api/search", "1.2.3.4", "u2"), { cache, nowMs });
	assert.equal(cache.store.size, 2, "两个不同身份应该是两条独立计数");
});

test("checkRateLimit：无 cookie 时行为与改造前完全一致（纯 IP 计数）", async () => {
	const cache = fakeCache();
	const rule = RATE_RULES.search;
	const nowMs = 1_700_000_000_000;
	for (let i = 0; i < rule.limit; i++) {
		await checkRateLimit(reqCid("/api/search", "1.2.3.4", null), { cache, nowMs });
	}
	assert.equal(
		(await checkRateLimit(reqCid("/api/search", "1.2.3.4", null), { cache, nowMs })).limited,
		true,
	);
});

test("checkRateLimit：Cache 不可用时一律放行（可用性优先）", async () => {
	const deps = { cache: null, nowMs: 1_700_000_000_000 };
	for (let i = 0; i < 100; i++) {
		assert.equal((await checkRateLimit(req("/api/search"), deps)).limited, false);
	}
});

test("checkRateLimit：Cache 抛异常时也放行，绝不让限流组件拖垮站点", async () => {
	const broken: MinimalCache = {
		async match() {
			throw new Error("cache down");
		},
		async put() {
			throw new Error("cache down");
		},
	};
	const r = await checkRateLimit(req("/api/search"), { cache: broken, nowMs: 1 });
	assert.equal(r.limited, false);
});

test("checkRateLimit：不参与限流的路径直接放行", async () => {
	const cache = fakeCache();
	const nowMs = 1_700_000_000_000;
	for (let i = 0; i < 500; i++) {
		const r = await checkRateLimit(req("/api/admin/import"), { cache, nowMs });
		assert.equal(r.limited, false);
	}
	assert.equal(cache.store.size, 0, "不该为未限流路径写入任何计数");
});

test("checkRateLimit：投毒的计数值不会被当成超额", async () => {
	const cache = fakeCache();
	const nowMs = 1_700_000_000_000;
	const win = windowIndex(nowMs, RATE_RULES.search.windowSec);
	const key = rateKey("search", win, "1.2.3.4");
	// 直接往 cache 里塞垃圾
	const url = "https://cache.auroratv.internal/rl/" + encodeURIComponent(key);
	cache.store.set(url, "not-a-number");

	assert.equal((await checkRateLimit(req("/api/search"), { cache, nowMs })).limited, false);
});

test("RATE_RULES：分片级端点（stream/img）的额度必须显著高于操作级端点", () => {
	// 这是本模块最容易踩的坑：把 stream 按「人操作次数」限流会误杀正常播放
	assert.ok(RATE_RULES.stream.limit >= RATE_RULES.search.limit * 10);
	assert.ok(RATE_RULES.img.limit >= RATE_RULES.search.limit * 10);
	assert.ok(RATE_RULES.stream.limit >= 600);
	// 所有规则都必须有正的窗口
	for (const [name, rule] of Object.entries(RATE_RULES)) {
		assert.ok(rule.limit > 0, `${name} limit 必须为正`);
		assert.ok(rule.windowSec > 0, `${name} windowSec 必须为正`);
	}
});
