// ---------------------------------------------------------------- 部署级配置

/**
 * 读取配置项；不存在时用 makeValue() 生成一个写入后再回读。
 *
 * 【为什么要「先插后读」而不是「先查后插再返回自己生成的值」】
 * Workers 会同时跑多个 isolate，首次访问时它们可能同时发现「没有值」，
 * 于是各自生成一份并写入。若直接返回自己生成的那份，就会出现
 * A isolate 用密钥1 签发、B isolate 用密钥2 校验 —— 表现为随机 403，
 * 且极难排查。改成 INSERT ... ON CONFLICT DO NOTHING + 回读之后，
 * 落库的那一份是唯一的权威值，所有 isolate 读到的都是同一个。
 *
 * 任何异常（迁移 0008 未执行、D1 未绑定、写额度耗尽）都降级为 null，
 * 由调用方决定兜底策略 —— 绝不能因为「读不到配置」让接口整体 500。
 */
export async function getOrCreateSetting(
	db: D1Database,
	key: string,
	makeValue: () => string,
): Promise<string | null> {
	try {
		const found = await db
			.prepare("SELECT value FROM app_setting WHERE key = ?1")
			.bind(key)
			.first<{ value: string }>();
		if (found?.value) return found.value;

		await db
			.prepare(
				"INSERT INTO app_setting (key, value, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING",
			)
			.bind(key, makeValue(), Date.now())
			.run();

		const after = await db
			.prepare("SELECT value FROM app_setting WHERE key = ?1")
			.bind(key)
			.first<{ value: string }>();
		return after?.value ?? null;
	} catch (e) {
		console.error(`getOrCreateSetting(${key}) failed:`, e);
		return null;
	}
}

/** 生成 32 字节（256 bit）随机密钥，hex 表示。 */
export function randomSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
	return s;
}

const PROXY_SECRET_KEY = "proxy_secret";

/**
 * 取（或首次生成）本部署的代理签名密钥。
 * 返回值只在成功落库/回读时为字符串；D1 不可用时返回 null，交由 lib/secret.ts 兜底。
 */
export function getOrCreatePersistedSecret(db: D1Database): Promise<string | null> {
	return getOrCreateSetting(db, PROXY_SECRET_KEY, randomSecret);
}

// ---------------------------------------------------------------- 源健康

export type SourceHealth = {
	source_id: string;
	success_rate: number;
	avg_latency_ms: number;
	score: number;
	updated_at: number;
	fail_streak?: number;
	auto_disabled?: number;
	last_ok_at?: number | null;
	cors?: number | null; // 1=网页可播（有 ACAO 头） 0=仅 VLC NULL=未检测
	cors_at?: number | null;
};

export async function getSourceHealthMap(db: D1Database): Promise<Record<string, SourceHealth>> {
	try {
		const { results } = await db.prepare("SELECT * FROM source_health").all<SourceHealth>();
		const map: Record<string, SourceHealth> = {};
		for (const r of results ?? []) map[r.source_id] = r;
		return map;
	} catch (e) {
		console.error("getSourceHealthMap failed:", e);
		return {};
	}
}

export async function upsertSourceHealth(db: D1Database, h: SourceHealth): Promise<void> {
	await db
		.prepare(
			`INSERT INTO source_health (source_id, success_rate, avg_latency_ms, score, updated_at, fail_streak, auto_disabled, last_ok_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
			 ON CONFLICT(source_id) DO UPDATE SET
			   success_rate=?2, avg_latency_ms=?3, score=?4, updated_at=?5, fail_streak=?6, auto_disabled=?7, last_ok_at=?8`,
		)
		.bind(
			h.source_id,
			h.success_rate,
			h.avg_latency_ms,
			h.score,
			h.updated_at,
			h.fail_streak ?? 0,
			h.auto_disabled ?? 0,
			h.last_ok_at ?? null,
		)
		.run();
}

// 仅更新「网页可播性」探测结果，不动其它健康字段（避免被体检覆盖）。
export async function upsertSourceCors(
	db: D1Database,
	source_id: string,
	cors: number | null,
	cors_at: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO source_health (source_id, cors, cors_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT(source_id) DO UPDATE SET cors=?2, cors_at=?3`,
		)
		.bind(source_id, cors, cors_at)
		.run();
}

export type ProbeTarget = {
	id: string;
	name: string;
	api: string;
	detail?: string;
	weight: number;
	enabled: boolean;
	fail_streak: number;
	auto_disabled: number;
	last_ok_at: number | null;
};

type ProbeTargetRow = {
	id: string;
	name: string;
	api: string;
	detail: string | null;
	weight: number;
	enabled: number;
	fail_streak: number | null;
	auto_disabled: number | null;
	last_ok_at: number | null;
};

// 返回需要探活的源：所有启用中的，外加「被自动停用」的（以便自动恢复）；
// 手动停用的（enabled=0 且 auto_disabled=0）不在其中。按最久未检测优先排序，便于分批轮询。
export async function getProbeTargets(db: D1Database, limit: number): Promise<ProbeTarget[]> {
	try {
		const { results } = await db
			.prepare(
				`SELECT s.id, s.name, s.api, s.detail, s.weight, s.enabled,
				        h.fail_streak AS fail_streak, h.auto_disabled AS auto_disabled, h.last_ok_at AS last_ok_at
				   FROM source s
				   LEFT JOIN source_health h ON h.source_id = s.id
				  WHERE s.enabled = 1 OR (s.enabled = 0 AND COALESCE(h.auto_disabled, 0) = 1)
				  ORDER BY (h.updated_at IS NULL) DESC, h.updated_at ASC
				  LIMIT ?1`,
			)
			.bind(limit)
			.all<ProbeTargetRow>();
		return (results ?? []).map((r) => ({
			id: r.id,
			name: r.name,
			api: r.api,
			detail: r.detail ?? undefined,
			weight: r.weight,
			enabled: r.enabled !== 0,
			fail_streak: r.fail_streak ?? 0,
			auto_disabled: r.auto_disabled ?? 0,
			last_ok_at: r.last_ok_at ?? null,
		}));
	} catch (e) {
		// 迁移 0004 未执行（缺列）等情况下降级为空，避免接口 500
		console.error("getProbeTargets failed:", e);
		return [];
	}
}

// 手动启用时清除自动停用标记与失败计数，避免下一轮又被误判停用。
export async function clearSourceAutoDisabled(db: D1Database, id: string): Promise<void> {
	try {
		await db
			.prepare("UPDATE source_health SET auto_disabled = 0, fail_streak = 0 WHERE source_id = ?1")
			.bind(id)
			.run();
	} catch (e) {
		console.error("clearSourceAutoDisabled failed:", e);
	}
}
