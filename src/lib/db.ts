export type SourceHealth = {
	source_id: string;
	success_rate: number;
	avg_latency_ms: number;
	score: number;
	updated_at: number;
};

export async function getSourceHealthMap(db: D1Database): Promise<Record<string, SourceHealth>> {
	const { results } = await db.prepare("SELECT * FROM source_health").all<SourceHealth>();
	const map: Record<string, SourceHealth> = {};
	for (const r of results ?? []) map[r.source_id] = r;
	return map;
}

export async function upsertSourceHealth(db: D1Database, h: SourceHealth): Promise<void> {
	await db
		.prepare(
			`INSERT INTO source_health (source_id, success_rate, avg_latency_ms, score, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(source_id) DO UPDATE SET
			   success_rate=?2, avg_latency_ms=?3, score=?4, updated_at=?5`,
		)
		.bind(h.source_id, h.success_rate, h.avg_latency_ms, h.score, h.updated_at)
		.run();
}
