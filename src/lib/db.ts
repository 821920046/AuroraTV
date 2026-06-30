export type SourceHealth = {
	source_id: string;
	success_rate: number;
	avg_latency_ms: number;
	score: number;
	updated_at: number;
	fail_streak?: number;
	auto_disabled?: number;
	last_ok_at?: number | null;
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
