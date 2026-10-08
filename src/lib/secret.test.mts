// secret.ts 的单测：密钥优先级、D1 读写次数、兜底与缓存行为。
// secret.ts 刻意只用相对路径 import（不依赖 tsconfig 的 paths 别名），
// 就是为了能被 Node 直接加载 —— 否则这段「优先级 + 缓存」逻辑只能靠人眼保证。
import assert from "node:assert/strict";
import { test } from "node:test";
import { __resetSecretCache, describeSecret, resolveProxySecret } from "./secret.ts";

// ---------------------------------------------------------------- 替身 D1

type Stmt = {
	bind(...a: unknown[]): Stmt;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<{ success: boolean }>;
};

function makeFakeDb() {
	const rows = new Map<string, string>();
	let selects = 0;
	let inserts = 0;

	const prepare = (sql: string): Stmt => {
		let args: unknown[] = [];
		const stmt: Stmt = {
			bind(...a: unknown[]) {
				args = a;
				return stmt;
			},
			async first<T>() {
				selects++;
				const key = String(args[0]);
				return (rows.has(key) ? { value: rows.get(key) } : null) as T | null;
			},
			async run() {
				if (/^\s*INSERT/i.test(sql)) {
					inserts++;
					const key = String(args[0]);
					if (!rows.has(key)) rows.set(key, String(args[1]));
				}
				return { success: true };
			},
		};
		return stmt;
	};

	return {
		db: { prepare } as unknown as D1Database,
		rows,
		stats: () => ({ selects, inserts }),
	};
}

// 每个用例都必须重置缓存 —— 否则前一个用例解析出来的密钥会漏到下一个用例里，
// 测试就会变成「谁先跑谁说了算」。
function fresh() {
	__resetSecretCache();
}

// ---------------------------------------------------------------- 优先级

test("STREAM_SECRET 存在时直接返回，且一次 D1 都不碰", async () => {
	fresh();
	const { db, stats } = makeFakeDb();

	const r = await resolveProxySecret({ STREAM_SECRET: "explicit-secret", AURORA_DB: db });
	assert.equal(r.secret, "explicit-secret");
	assert.equal(r.source, "env");
	assert.deepEqual(stats(), { selects: 0, inserts: 0 });
});

test("未配 STREAM_SECRET 时回退到 CRON_SECRET（兼容既有部署）", async () => {
	fresh();
	const { db, stats } = makeFakeDb();

	const r = await resolveProxySecret({ CRON_SECRET: "cron", AURORA_DB: db });
	assert.equal(r.secret, "cron");
	assert.equal(r.source, "env");
	assert.deepEqual(stats(), { selects: 0, inserts: 0 });
});

test("什么都没配时自动生成 64 位 hex 密钥并落库（source=d1）", async () => {
	fresh();
	const { db, rows, stats } = makeFakeDb();

	const r = await resolveProxySecret({ AURORA_DB: db });
	assert.equal(r.source, "d1");
	assert.match(r.secret, /^[0-9a-f]{64}$/);
	assert.equal(rows.get("proxy_secret"), r.secret);
	assert.equal(stats().inserts, 1);
});

test("PASSWORD 不参与密钥解析：只有 PASSWORD 时依然会去 D1 取随机密钥", async () => {
	fresh();
	const { db } = makeFakeDb();

	// 关键回归点：旧实现里 PASSWORD 会直接当签名密钥用 ——
	// 那意味着「后台口令 = 铸造代理令牌的能力」。
	const r = await resolveProxySecret({ PASSWORD: "admin123", AURORA_DB: db } as unknown as {
		AURORA_DB?: D1Database;
	});
	assert.equal(r.source, "d1");
	assert.notEqual(r.secret, "admin123");
});

// ---------------------------------------------------------------- 兜底

test("没有 D1 绑定时回退到公开常量，并标记为 weak", async () => {
	fresh();
	const r = await resolveProxySecret({});
	assert.equal(r.source, "fallback");
	assert.equal(describeSecret(r).weak, true);
});

test("D1 存在但迁移未执行时同样回退（不抛错）", async () => {
	fresh();
	const broken = {
		prepare() {
			throw new Error("no such table: app_setting");
		},
	} as unknown as D1Database;

	const r = await resolveProxySecret({ AURORA_DB: broken });
	assert.equal(r.source, "fallback");
	assert.equal(describeSecret(r).weak, true);
});

test("describeSecret：正常密钥不会被误判为 weak", async () => {
	fresh();
	const r = await resolveProxySecret({ STREAM_SECRET: "s".repeat(64) });
	assert.deepEqual(describeSecret(r), { source: "env", weak: false });
});

// ---------------------------------------------------------------- 缓存

test("isolate 内缓存：连续多次解析只读一次 D1", async () => {
	fresh();
	const { db, stats } = makeFakeDb();

	const a = await resolveProxySecret({ AURORA_DB: db });
	// 首次解析本身需要 2 次 SELECT（先查、INSERT 后再回读），这是必须的。
	const afterFirst = stats();
	assert.equal(afterFirst.selects, 2);
	assert.equal(afterFirst.inserts, 1);

	const b = await resolveProxySecret({ AURORA_DB: db });
	const c = await resolveProxySecret({ AURORA_DB: db });

	assert.equal(a.secret, b.secret);
	assert.equal(b.secret, c.secret);
	// 每个分片请求都要用密钥，若每次都查 D1 就是白白烧读额度 + 多一次往返。
	assert.deepEqual(stats(), afterFirst);
});

test("兜底态不永久缓存：缓存失效后会重新尝试 D1", async () => {
	fresh();
	// 第一次：D1 不可用 -> fallback
	const broken = {
		prepare() {
			throw new Error("boom");
		},
	} as unknown as D1Database;
	const first = await resolveProxySecret({ AURORA_DB: broken });
	assert.equal(first.source, "fallback");

	// 兜底态被缓存了，所以立刻再调仍是同一个结果（不重复打 D1）
	const second = await resolveProxySecret({ AURORA_DB: broken });
	assert.equal(second, first);

	// 但兜底缓存必须带过期时间 —— 否则 D1 一次抖动就会让这个 isolate
	// 在整个生命周期内都用公开常量。这里把时钟推到 TTL 之后再验证。
	const realNow = Date.now;
	Date.now = () => realNow() + 61_000;
	try {
		const { db } = makeFakeDb();
		const third = await resolveProxySecret({ AURORA_DB: db });
		assert.equal(third.source, "d1");
		assert.match(third.secret, /^[0-9a-f]{64}$/);
	} finally {
		Date.now = realNow;
	}
});
