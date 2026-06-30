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

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetchWithTimeout(url, TIMEOUT_MS);
		if (!res.ok) return null;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// 按健康评分（或静态权重）排序，取前 MAX_FANOUT 个源
function pickSources(
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
	webOnly = false,
): VideoSource[] {
	let list = sources.filter((s) => s.enabled !== false);
	// webOnly：仅保留「网页可播」(cors===1) 的源；若一个都没检测出来则退回全部，避免空结果。
	if (webOnly) {
		const playable = list.filter((s) => health?.[s.id]?.cors === 1);
		if (playable.length > 0) list = playable;
	}
	list.sort((a, b) => {
		// 🌐 网页可播优先，其次按健康评分/权重
		const ca = health?.[a.id]?.cors === 1 ? 1 : 0;
		const cb = health?.[b.id]?.cors === 1 ? 1 : 0;
		if (ca !== cb) return cb - ca;
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
	webOnly = false,
): Promise<SearchItem[]> {
	const picked = pickSources(sources, health, webOnly);
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
	// 调用方会决定传入“启用源”还是“全部源”。这里不要再按 enabled 过滤，
	// 否则首页/搜索缓存里的结果在片源被体检自动停用后会播放 500。
	const s = sources.find((x) => x.id === sourceId);
	if (!s) throw new Error("找不到对应片源，可能已被删除或缓存已过期");
	const url = `${s.api}?ac=detail&ids=${encodeURIComponent(vodId)}`;
	// 详情是单个请求（非扣散），超时给到 8 秒，避免慢源 3 秒超时导致播放失败。
	const res = await fetchWithTimeout(url, 8000);
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
// 为什么不能只拉「最近更新页」：采集站的最近更新几乎都是剧集/动漫（每日更新集数），
// 电影占比极低，会导致首页只有剧集。因此改为「按类目精准抓取」：
// 先拉分类表（ac=list 的 class）定位电影/电视剧类目 id，再分别取最新一页（带海报）。
export type RecentItem = SearchItem & { type_name?: string };

type ClassItem = { type_id: number; type_name: string };

function mapRow(sourceId: string, v: Record<string, unknown>): RecentItem {
	return {
		source_id: sourceId,
		vod_id: String(v.vod_id),
		title: String(v.vod_name ?? ""),
		poster: v.vod_pic ? String(v.vod_pic) : undefined,
		year: v.vod_year ? Number(v.vod_year) : undefined,
		remarks: v.vod_remarks ? String(v.vod_remarks) : undefined,
		type_name: v.type_name ? String(v.type_name) : undefined,
	};
}

function asList(data: Record<string, unknown> | null): Array<Record<string, unknown>> {
	const l = (data as { list?: unknown })?.list;
	return Array.isArray(l) ? (l as Array<Record<string, unknown>>) : [];
}

function isTvName(n: string): boolean {
	return /剧|电视|连续/.test(n);
}

function isMovieName(n: string): boolean {
	return /电影|影片|片/.test(n) && !/动漫|动画|综艺/.test(n);
}

// 从 MacCMS 的 class 分类表里挑出电影 / 电视剧类目 id
function pickCategoryIds(classes: ClassItem[]): { movieIds: number[]; tvIds: number[] } {
	const movieIds: number[] = [];
	const tvIds: number[] = [];
	for (const c of classes) {
		const n = c.type_name ?? "";
		if (Number.isNaN(c.type_id)) continue;
		if (isTvName(n)) tvIds.push(c.type_id);
		else if (isMovieName(n)) movieIds.push(c.type_id);
	}
	return { movieIds, tvIds };
}

function byRecency(a: RecentItem, b: RecentItem): number {
	const pa = a.poster ? 1 : 0;
	const pb = b.poster ? 1 : 0;
	if (pa !== pb) return pb - pa;
	return (b.year ?? 0) - (a.year ?? 0);
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

async function fetchCategory(
	s: VideoSource,
	ids: number[],
): Promise<RecentItem[]> {
	const out: RecentItem[] = [];
	// 取前两个匹配类目（如「电影」与某热门子类），控制子请求数
	for (const id of ids.slice(0, 2)) {
		const data = await fetchJson(`${s.api}?ac=detail&t=${id}&pg=1`);
		for (const v of asList(data)) out.push(mapRow(s.id, v));
	}
	return out;
}

export async function aggregateRecent(
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
	maxSources = 4,
	webOnly = false,
): Promise<{ movies: RecentItem[]; tv: RecentItem[] }> {
	const picked = pickSources(sources, health, webOnly).slice(0, maxSources);
	const tasks = picked.map(async (s) => {
		const movies: RecentItem[] = [];
		const tv: RecentItem[] = [];

		// 1) 拉分类表，定位「电影」「电视剧」类目 id
		const listData = await fetchJson(`${s.api}?ac=list`);
		const rawClass = Array.isArray((listData as { class?: unknown })?.class)
			? (listData as { class: Array<Record<string, unknown>> }).class
			: [];
		const classes: ClassItem[] = rawClass.map((c) => ({
			type_id: Number(c.type_id),
			type_name: String(c.type_name ?? ""),
		}));
		const { movieIds, tvIds } = pickCategoryIds(classes);

		// 2) 按类目分别取最新一页（带 vod_pic 海报）
		const [m, t] = await Promise.all([
			movieIds.length ? fetchCategory(s, movieIds) : Promise.resolve([] as RecentItem[]),
			tvIds.length ? fetchCategory(s, tvIds) : Promise.resolve([] as RecentItem[]),
		]);
		movies.push(...m);
		tv.push(...t);

		// 3) 兜底：分类识别失败时，退回混合最新页并按名称归类
		if (movies.length === 0 && tv.length === 0) {
			const mixed = await fetchJson(`${s.api}?ac=detail&pg=1`);
			for (const v of asList(mixed)) {
				const item = mapRow(s.id, v);
				const tn = item.type_name ?? "";
				if (isTvName(tn)) tv.push(item);
				else if (isMovieName(tn)) movies.push(item);
			}
		}
		return { movies, tv };
	});

	const settled = await Promise.allSettled(tasks);
	const allMovies: RecentItem[] = [];
	const allTv: RecentItem[] = [];
	for (const r of settled) {
		if (r.status === "fulfilled") {
			allMovies.push(...r.value.movies);
			allTv.push(...r.value.tv);
		}
	}
	return {
		movies: dedupeRecent(allMovies).sort(byRecency),
		tv: dedupeRecent(allTv).sort(byRecency),
	};
}

// ---- 点播取流：智能挑选可直连的播放组 ----
// MacCMS 的 vod_play_url 常有多组（$$$ 分隔），与 vod_play_from 一一对应。
// 很多源第一组是 qq/爱奇艺/优酷等需要解析的云链接（非直链），
// 直接取第一组会导致“全部无法播放”。这里挑选直链占比最高、且非云解析源的播放组。
const CLOUD_SOURCE_RE =
	/qq|qiyi|iqiyi|youku|优酷|腾讯|爱奇艺|mgtv|芒果|letv|乐视|sohu|搜狐|pptv|bilibili|哔哩|xigua|网盘|magnet|百度|ed2k/i;

function isDirectUrl(u: string): boolean {
	return /\.m3u8|\.mp4|\.flv|\.ts(\?|$)/i.test(u);
}

function parseGroup(group: string): Episode[] {
	return (group ?? "")
		.split("#")
		.map((seg) => {
			const [name, url] = seg.split("$");
			return { name: name ?? "", url: url ?? "" };
		})
		.filter((e) => e.url);
}

export function pickPlayGroup(vodPlayUrl: string, vodPlayFrom?: string): Episode[] {
	const urlGroups = (vodPlayUrl ?? "").split("$$$");
	const fromGroups = (vodPlayFrom ?? "").split("$$$");
	let best: Episode[] = [];
	let bestScore = -Infinity;
	for (let i = 0; i < urlGroups.length; i++) {
		const eps = parseGroup(urlGroups[i]);
		if (eps.length === 0) continue;
		const fromName = fromGroups[i] ?? "";
		const directCount = eps.filter((e) => isDirectUrl(e.url)).length;
		let score = directCount / eps.length;
		if (directCount === 0) score -= 1; // 完全无直链（多为网页/云链接）大幅降��
		if (CLOUD_SOURCE_RE.test(fromName)) score -= 1; // 已知云解析源降权
		if (score > bestScore) {
			bestScore = score;
			best = eps;
		}
	}
	// 全都没有直链时，退回第一组
	if (best.length === 0 && urlGroups.length > 0) best = parseGroup(urlGroups[0]);
	return best;
}
