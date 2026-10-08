// db.ts 的零依赖单测。db.ts 不 import 任何模块（只依赖 D1Database 这个全局类型），
// 因此可以像 proxy.ts 一样被 Node 直接加载 —— 用替身 D1 就能覆盖真实的 SQL 时序。
// 运行：npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrCreatePersistedSecret, getOrCreateSetting, randomSecret } from "./db.ts";

// ---------------------------------------------------------------- 替身 D1

type FakeStmt = {
	bind(...a: unknown[]): FakeStmt;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<{ success: boolean }>;
};

type FakeOptions = {
	/** 让表「不存在」，模拟迁移 0008 未执行 / D1 未绑定 */
	fail?: boolean;
	/** 首次 SELECT 假装查不到，但表里其实已经有值 —— 用来复现多 isolate 竞态 */
	hideFirstSelect?: boolean;
};

function makeFakeDb(opts: FakeOptions = {}) {
	const rows = new Map<string, string>();
	const log: string[] = [];
	let selects = 0;

	const prepare = (sql: string): FakeStmt => {
		let args: unknown[] = [];
		const stmt: FakeStmt = {
			bind(...a: unknown[]) {
				args = a;
				return stmt;
			},
			async first<T>() {
				if (opts.fail) throw new Error("no such table: app_setting");
				selects++;
				log.push("select");
				if (opts.hideFirstSelect && selects === 1) return null;
				const key = String(args[0]);
				return (rows.has(key) ? { value: rows.get(key) } : null) as T | null;
			},
			async run() {
				if (opts.fail) throw new Error("no such table: app_setting");
				if (/^\s*INSERT/i.test(sql)) {
					log.push("insert");
					const key = String(args[0]);
					// ON CONFLICT(key) DO NOTHING 的语义：已存在就一个字节都不写
					if (!rows.has(key)) rows.set(key, String(args[1]));
				}
				return { success: true };
			},
		};
		return stmt;
	};

	return { db: { prepare } as unknown as D1Database, rows, log };
}

// ---------------------------------------------------------------- randomSecret

test("randomSecret：32 字节 hex，长度 64 且每次不同", () => {
	const a = randomSecret();
	const b = randomSecret();
	assert.equal(a.length, 64);
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.notEqual(a, b);
});

// ---------------------------------------------------------------- 正常路径

test("getOrCreateSetting：首次生成并落库，之后直接读回同一个值", async () => {
	const { db, rows, log } = makeFakeDb();
	let made = 0;

	const first = await getOrCreateSetting(db, "k", () => {
		made++;
		return "generated-1";
	});
	assert.equal(first, "generated-1");
	assert.equal(rows.get("k"), "generated-1");
	assert.equal(made, 1);

	const second = await getOrCreateSetting(db, "k", () => {
		made++;
		return "generated-2";
	});
	assert.equal(second, "generated-1");
	// 已存在时绝不能再调用 makeValue —— 否则等于白白做一次随机数生成，
	// 更糟的是会掩盖「明明有值却生成新值」的逻辑错误。
	assert.equal(made, 1);
	assert.equal(log.filter((x) => x === "insert").length, 1);
});

test("getOrCreateSetting：并发竞态下回读到的始终是落库那一份（不会各写各的）", async () => {
	// 场景：A isolate 先写入 "winner"，B isolate 的 SELECT 发生在写入之前（读到空），
	// 随后 B 的 INSERT 被 ON CONFLICT DO NOTHING 丢弃，B 回读必须拿到 "winner"。
	// 若实现改成「返回自己生成的值」，就会出现 A 用密钥1 签发、B 用密钥2 校验的随机 403。
	const { db, rows } = makeFakeDb({ hideFirstSelect: true });
	rows.set("k", "winner");

	const got = await getOrCreateSetting(db, "k", () => "loser");
	assert.equal(got, "winner");
	assert.equal(rows.get("k"), "winner");
});

test("getOrCreatePersistedSecret：落到固定的 proxy_secret 键上", async () => {
	const { db, rows } = makeFakeDb();
	const s1 = await getOrCreatePersistedSecret(db);
	const s2 = await getOrCreatePersistedSecret(db);
	assert.match(String(s1), /^[0-9a-f]{64}$/);
	assert.equal(s1, s2);
	assert.equal(rows.get("proxy_secret"), s1);
});

// ---------------------------------------------------------------- 降级路径

test("getOrCreateSetting：表不存在 / D1 不可用时返回 null 而不是抛错", async () => {
	const { db } = makeFakeDb({ fail: true });
	// 关键：绝不能因为「读不到配置」把异常抛给上层 —— 那会让整个接口 500，
	// 而正确行为是让调用方回退（见 lib/secret.ts）。
	await assert.doesNotReject(async () => {
		assert.equal(await getOrCreateSetting(db, "k", () => "v"), null);
		assert.equal(await getOrCreatePersistedSecret(db), null);
	});
});
