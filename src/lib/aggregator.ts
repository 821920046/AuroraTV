import type { VideoSource } from "./sources";
import type { SourceHealth } from "./db";

const MAX_FANOUT = 6; // ≤ 子请求上限（免费 50），留余量
const TIMEOUT_MS = 3000;

export type SearchItem = {
	source_id: string;
	vod_id: string;
	title: string;
	poster?: string;
	year?: number;
	remarks?: string;
};

export type Episode = { name: string; url: string };

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

// 按健康评分（或静态权重）排序，取前 MAX_FANOUT 个源
function pickSources(sources: VideoSource[], health?: Record<string, SourceHealth>): VideoSource[] {
	const list = sources.filter((s) => s.enabled !== false);
	list.sort((a, b) => {
		const sa = health?.[a.id]?.score ?? a.weight ?? 0;
		const sb = health?.[b.id]?.score ?? b.weight ?? 0;
		return sb - sa;
	});
	return list.slice(0, MAX_FANOUT);
}

export async function aggregateSearch(
	keyword: string,
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
): Promise<SearchItem[]> {
	const picked = pickSources(sources, health);
	const tasks = picked.map(async (s) => {
		const url = `${s.api}?ac=detail&wd=${encodeURIComponent(keyword)}`;
		const res = await fetchWithTimeout(url, TIMEOUT_MS);
		if (!res.ok) throw new Error(`source ${s.id} ${res.status}`);
		const data = (await res.json()) as { list?: Array<Record<string, unknown>> };
		const list = data?.list ?? [];
		return list.map((v) => ({
			source_id: s.id,
			vod_id: String(v.vod_id),
			title: String(v.vod_name ?? ""),
			poster: v.vod_pic ? String(v.vod_pic) : undefined,
			year: v.vod_year ? Number(v.vod_year) : undefined,
			remarks: v.vod_remarks ? String(v.vod_remarks) : undefined,
		})) as SearchItem[];
	});

	// 搜索要合并多源，所以收集所有成功结果（而不是只取最快）
	const settled = await Promise.allSettled(tasks);
	const merged: SearchItem[] = [];
	for (const r of settled) if (r.status === "fulfilled") merged.push(...r.value);
	return dedupe(merged);
}

export async function fetchDetail(
	sources: VideoSource[],
	sourceId: string,
	vodId: string,
): Promise<Record<string, unknown> | null> {
	const s = sources.find((x) => x.id === sourceId && x.enabled !== false);
	if (!s) throw new Error("unknown source");
	const url = `${s.api}?ac=detail&ids=${encodeURIComponent(vodId)}`;
	const res = await fetchWithTimeout(url, TIMEOUT_MS);
	if (!res.ok) throw new Error(`detail ${res.status}`);
	const data = (await res.json()) as { list?: Array<Record<string, unknown>> };
	return data?.list?.[0] ?? null;
}

// 解析 MacCMS 的 vod_play_url：形如 "第1集$http...m3u8#第2集$http...m3u8"
// 多个播放组以 $$$ 分隔，这里取第一组。
export function parsePlayUrl(vodPlayUrl: string): Episode[] {
	const group = (vodPlayUrl ?? "").split("$$$")[0] ?? "";
	return group
		.split("#")
		.map((seg) => {
			const [name, url] = seg.split("$");
			return { name: name ?? "", url: url ?? "" };
		})
		.filter((e) => e.url);
}

function dedupe(items: SearchItem[]): SearchItem[] {
	const seen = new Set<string>();
	const out: SearchItem[] = [];
	for (const it of items) {
		const k = `${it.title}:${it.year ?? ""}`;
		if (!seen.has(k)) {
			seen.add(k);
			out.push(it);
		}
	}
	return out;
}

// ---- 首页「近期热播」聚合 ----
// 通过 MacCMS 的 ac=detail&pg=1 拉取各源「最近更新」的条目（含 vod_pic 海报），
// 合并去重后按类型分桶为 电影 / 电视剧。pg=1 即最新更新页，天然反映近期热播。
export type RecentItem = SearchItem & { type_name?: string };

export async function aggregateRecent(
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
	maxSources = 4,
): Promise<RecentItem[]> {
	const picked = pickSources(sources, health).slice(0, maxSources);
	const tasks = picked.map(async (s) => {
		const url = `${s.api}?ac=detail&pg=1`;
		const res = await fetchWithTimeout(url, TIMEOUT_MS);
		if (!res.ok) throw new Error(`source ${s.id} ${res.status}`);
		const data = (await res.json()) as { list?: Array<Record<string, unknown>> };
		const list = data?.list ?? [];
		return list.map((v) => ({
			source_id: s.id,
			vod_id: String(v.vod_id),
			title: String(v.vod_name ?? ""),
			poster: v.vod_pic ? String(v.vod_pic) : undefined,
			year: v.vod_year ? Number(v.vod_year) : undefined,
			remarks: v.vod_remarks ? String(v.vod_remarks) : undefined,
			type_name: v.type_name ? String(v.type_name) : undefined,
		})) as RecentItem[];
	});
	const settled = await Promise.allSettled(tasks);
	const merged: RecentItem[] = [];
	for (const r of settled) if (r.status === "fulfilled") merged.push(...r.value);
	return dedupeRecent(merged);
}

function dedupeRecent(items: RecentItem[]): RecentItem[] {
	const seen = new Set<string>();
	const out: RecentItem[] = [];
	for (const it of items) {
		if (!it.title) continue;
		const k = `${it.title}:${it.year ?? ""}`;
		if (!seen.has(k)) {
			seen.add(k);
			out.push(it);
		}
	}
	return out;
}

// 有海报的优先，其次按年份降序（近期作品靠前）
function byRecency(a: RecentItem, b: RecentItem): number {
	const pa = a.poster ? 1 : 0;
	const pb = b.poster ? 1 : 0;
	if (pa !== pb) return pb - pa;
	return (b.year ?? 0) - (a.year ?? 0);
}

export function classifyRecent(items: RecentItem[]): { movies: RecentItem[]; tv: RecentItem[] } {
	const movies: RecentItem[] = [];
	const tv: RecentItem[] = [];
	for (const it of items) {
		const t = it.type_name ?? "";
		if (/剧|电视|连续/.test(t)) tv.push(it);
		else if (/电影|影片|片/.test(t)) movies.push(it);
	}
	// 若分类信息缺失导致两桶皆空，则把全部并入电影，避免首页空白
	if (movies.length === 0 && tv.length === 0 && items.length > 0) {
		movies.push(...items);
	}
	movies.sort(byRecency);
	tv.sort(byRecency);
	return { movies, tv };
}
