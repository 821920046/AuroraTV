// 影视源注册表（D1 持久化版本）。
// 源由站长在 /admin 后台管理，或从订阅 JSON 批量导入，绝不写死第三方源到仓库。
// 采用常见的苹果CMS (MacCMS) vod JSON API 约定：
//   搜索: {api}?ac=detail&wd=关键词
//   详情: {api}?ac=detail&ids=xxx

export type VideoSource = {
	id: string;
	name: string;
	api: string; // 形如 https://example.com/api.php/provide/vod
	detail?: string; // 可选：网页详情根 URL
	weight?: number; // 静态初始权重（尚无健康评分时使用）
	enabled?: boolean;
};

// 静态种子源（默认留空，保持合规）。仅当 D1 未绑定或表为空时作为兜底。
export const SEED_SOURCES: VideoSource[] = [];

type SourceRow = {
	id: string;
	name: string;
	api: string;
	detail: string | null;
	weight: number;
	enabled: number;
};

function rowToSource(r: SourceRow): VideoSource {
	return {
		id: r.id,
		name: r.name,
		api: r.api,
		detail: r.detail ?? undefined,
		weight: r.weight,
		enabled: r.enabled !== 0,
	};
}

// 由名称/接口生成稳定且合法的 id
export function makeSourceId(name: string, api: string): string {
	const base = (name || api || "src")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
	return base || "src";
}

export async function getAllSources(db?: D1Database): Promise<VideoSource[]> {
	if (!db) return SEED_SOURCES;
	try {
		const { results } = await db
			.prepare("SELECT id, name, api, detail, weight, enabled FROM source ORDER BY weight DESC, name ASC")
			.all<SourceRow>();
		if (!results || results.length === 0) return SEED_SOURCES;
		return results.map(rowToSource);
	} catch (e) {
		// 表不存在（迁移未执行）或查询失败时降级为空，避免接口 500
		console.error("getAllSources failed:", e);
		return SEED_SOURCES;
	}
}

export async function getEnabledSources(db?: D1Database): Promise<VideoSource[]> {
	const all = await getAllSources(db);
	return all.filter((s) => s.enabled !== false);
}

export async function upsertSource(db: D1Database, s: VideoSource): Promise<void> {
	await db
		.prepare(
			`INSERT INTO source (id, name, api, detail, weight, enabled, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
			 ON CONFLICT(id) DO UPDATE SET
			   name=?2, api=?3, detail=?4, weight=?5, enabled=?6`,
		)
		.bind(
			s.id,
			s.name,
			s.api,
			s.detail ?? null,
			s.weight ?? 1,
			s.enabled === false ? 0 : 1,
			Date.now(),
		)
		.run();
}

export async function deleteSource(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM source WHERE id = ?1").bind(id).run();
}

export async function setSourceEnabled(db: D1Database, id: string, enabled: boolean): Promise<void> {
	await db.prepare("UPDATE source SET enabled = ?2 WHERE id = ?1").bind(id, enabled ? 1 : 0).run();
}

export async function importSources(db: D1Database, list: VideoSource[]): Promise<number> {
	if (list.length === 0) return 0;
	const now = Date.now();
	const stmts = list.map((s) =>
		db
			.prepare(
				`INSERT INTO source (id, name, api, detail, weight, enabled, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				 ON CONFLICT(id) DO UPDATE SET
				   name=?2, api=?3, detail=?4, weight=?5, enabled=?6`,
			)
			.bind(s.id, s.name, s.api, s.detail ?? null, s.weight ?? 1, s.enabled === false ? 0 : 1, now),
	);
	await db.batch(stmts);
	return list.length;
}

// 把多种订阅格式归一化为 VideoSource[]：
//  - MoonTV / LunaTV: { api_site: { key: { api, name, detail } } }
//  - KVideo: [{ name, baseUrl, ... }] 或 { sources: [...] } / { list: [...] }
//  - AuroraTV 自身: [{ id, name, api, ... }]
export function parseSubscription(data: unknown): VideoSource[] {
	const out: VideoSource[] = [];
	const seen = new Set<string>();

	const add = (raw: Record<string, unknown>, fallbackKey?: string) => {
		const api = (raw.api ?? raw.baseUrl ?? raw.url) as string | undefined;
		if (!api || typeof api !== "string") return;
		const name = String(raw.name ?? raw.id ?? fallbackKey ?? "未命名源");
		const idSeed = String(raw.id ?? raw.key ?? fallbackKey ?? name);
		let id = makeSourceId(idSeed, api);
		while (seen.has(id)) id = id + "_x";
		seen.add(id);
		const priority = raw.priority != null ? Number(raw.priority) : undefined;
		const weight =
			raw.weight != null
				? Number(raw.weight)
				: priority != null && priority > 0
					? Number((1 / priority).toFixed(3))
					: 1;
		out.push({
			id,
			name,
			api,
			detail: raw.detail ? String(raw.detail) : undefined,
			weight,
			enabled: raw.enabled !== false,
		});
	};

	const fromArray = (arr: unknown[]) => {
		for (const v of arr) if (v && typeof v === "object") add(v as Record<string, unknown>);
	};
	const fromApiSite = (obj: Record<string, unknown>) => {
		for (const [key, v] of Object.entries(obj))
			if (v && typeof v === "object") add(v as Record<string, unknown>, key);
	};

	if (Array.isArray(data)) {
		fromArray(data);
	} else if (data && typeof data === "object") {
		const o = data as Record<string, unknown>;
		if (Array.isArray(o.sources)) fromArray(o.sources);
		else if (Array.isArray(o.list)) fromArray(o.list);
		else if (o.api_site && typeof o.api_site === "object") fromApiSite(o.api_site as Record<string, unknown>);
		else fromApiSite(o);
	}
	return out;
}
