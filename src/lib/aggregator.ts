import type { VideoSource } from "./sources";
import type { SourceHealth } from "./db";
import { fetchJson, fetchWithTimeout, parseJsonLoose, upstreamHeaders } from "./http";

// Cloudflare 免费版单请求子请求上限 50。搜索扇出给到 8，剩余额度留给 D1 / 缓存 / 重试。
const MAX_FANOUT = 8;
const SEARCH_TIMEOUT_MS = 5000;
const DETAIL_TIMEOUT_MS = 9000;

export type SearchItem = {
	source_id: string;
	source_name?: string;
	vod_id: string;
	title: string;
	poster?: string;
	year?: number;
	remarks?: string;
	type_name?: string;
	/** 同一部片在其它源上的副本，用于前端「一键换源」 */
	alts?: Array<{ source_id: string; source_name?: string; vod_id: string }>;
};

export type Episode = { name: string; url: string };

// 排序：网页可直连（cors=1）优先 -> 健康评分 -> 静态权重。
// 注意：自从上了同源代理，cors=0 的源也能播，因此不再「过滤掉」，只做「降权」。
function pickSources(
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
	limit = MAX_FANOUT,
): VideoSource[] {
	const list = sources.filter((s) => s.enabled !== false);
	list.sort((a, b) => {
		const ca = health?.[a.id]?.cors === 1 ? 1 : 0;
		const cb = health?.[b.id]?.cors === 1 ? 1 : 0;
		if (ca !== cb) return cb - ca;
		const sa = health?.[a.id]?.score ?? a.weight ?? 0;
		const sb = health?.[b.id]?.score ?? b.weight ?? 0;
		return sb - sa;
	});
	return list.slice(0, limit);
}

function mapRow(s: VideoSource, v: Record<string, unknown>): SearchItem {
	return {
		source_id: s.id,
		source_name: s.name,
		vod_id: String(v.vod_id ?? ""),
		title: String(v.vod_name ?? "").trim(),
		poster: v.vod_pic ? String(v.vod_pic) : undefined,
		year: v.vod_year ? Number(v.vod_year) : undefined,
		remarks: v.vod_remarks ? String(v.vod_remarks) : undefined,
		type_name: v.type_name ? String(v.type_name) : undefined,
	};
}

function asList(data: unknown): Array<Record<string, unknown>> {
	const l = (data as { list?: unknown } | null)?.list;
	return Array.isArray(l) ? (l as Array<Record<string, unknown>>) : [];
}

/** 归一化标题，用于跨源合并同一部片（去空白 / 括号 / 副标题） */
function titleKey(it: SearchItem): string {
	const t = it.title
		.toLowerCase()
		.replace(/[\s\u3000]+/g, "")
		.replace(/[\[\]\uff08\uff09()《》:：\-_.]/g, "");
	return t + "|" + (it.year ?? "");
}

/**
 * 跨源合并：同名同年份的只保留一张卡，但把其它源存进 alts。
 * 原实现直接丢弃重复项 -> 一旦首选源挂了就彻底无法播放，现在可以自动换源。
 */
function mergeByTitle(items: SearchItem[]): SearchItem[] {
	const map = new Map<string, SearchItem>();
	for (const it of items) {
		if (!it.title || !it.vod_id) continue;
		const k = titleKey(it);
		const prev = map.get(k);
		if (!prev) {
			map.set(k, { ...it, alts: [] });
			continue;
		}
		if (!prev.poster && it.poster) prev.poster = it.poster;
		if (!prev.remarks && it.remarks) prev.remarks = it.remarks;
		if (prev.source_id !== it.source_id) {
			prev.alts = prev.alts ?? [];
			if (prev.alts.length < 8)
				prev.alts.push({
					source_id: it.source_id,
					source_name: it.source_name,
					vod_id: it.vod_id,
				});
		}
	}
	return [...map.values()];
}

export async function aggregateSearch(
	keyword: string,
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
): Promise<SearchItem[]> {
	const picked = pickSources(sources, health);
	const tasks = picked.map(async (s) => {
		const url = `${s.api}?ac=detail&wd=${encodeURIComponent(keyword)}`;
		const data = await fetchJson(url, { timeoutMs: SEARCH_TIMEOUT_MS, retries: 1 });
		return asList(data).map((v) => mapRow(s, v));
	});

	const settled = await Promise.allSettled(tasks);
	const merged: SearchItem[] = [];
	for (const r of settled) if (r.status === "fulfilled") merged.push(...r.value);

	// 健康度高的源排前，合并时就会被选为主源
	const order = new Map(picked.map((s, i) => [s.id, i]));
	merged.sort((a, b) => (order.get(a.source_id) ?? 99) - (order.get(b.source_id) ?? 99));
	return mergeByTitle(merged);
}

export async function fetchDetail(
	sources: VideoSource[],
	sourceId: string,
	vodId: string,
): Promise<Record<string, unknown> | null> {
	const s = sources.find((x) => x.id === sourceId);
	if (!s) throw new Error("找不到对应片源，可能已被删除或缓存已过期");
	const url = `${s.api}?ac=detail&ids=${encodeURIComponent(vodId)}`;
	const res = await fetchWithTimeout(url, {
		timeoutMs: DETAIL_TIMEOUT_MS,
		retries: 1,
		headers: upstreamHeaders(url),
	});
	if (!res.ok) throw new Error(`片源返回 ${res.status}`);
	const data = parseJsonLoose<{ list?: Array<Record<string, unknown>> }>(await res.text());
	return data?.list?.[0] ?? null;
}

export function parsePlayUrl(vodPlayUrl: string): Episode[] {
	return parseGroup((vodPlayUrl ?? "").split("$$$")[0] ?? "");
}

// ---- 首页「近期热播」聚合 ----
export type RecentItem = SearchItem;

type ClassItem = { type_id: number; type_name: string };

function isTvName(n: string): boolean {
	return /剧|电视|连续/.test(n);
}

function isMovieName(n: string): boolean {
	return /电影|影片|片/.test(n) && !/动漫|动画|综艺/.test(n);
}

function pickCategoryIds(classes: ClassItem[]): { movieIds: number[]; tvIds: number[] } {
	const movieIds: number[] = [];
	const tvIds: number[] = [];
	for (const c of classes) {
		const n = c.type_name ?? "";
		if (!Number.isFinite(c.type_id)) continue;
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

async function fetchCategory(s: VideoSource, ids: number[]): Promise<RecentItem[]> {
	const out: RecentItem[] = [];
	for (const id of ids.slice(0, 2)) {
		const data = await fetchJson(`${s.api}?ac=detail&t=${id}&pg=1`, {
			timeoutMs: SEARCH_TIMEOUT_MS,
		});
		for (const v of asList(data)) out.push(mapRow(s, v));
	}
	return out;
}

export async function aggregateRecent(
	sources: VideoSource[],
	health?: Record<string, SourceHealth>,
	maxSources = 4,
): Promise<{ movies: RecentItem[]; tv: RecentItem[] }> {
	const picked = pickSources(sources, health, maxSources);
	const tasks = picked.map(async (s) => {
		const movies: RecentItem[] = [];
		const tv: RecentItem[] = [];

		const listData = await fetchJson(`${s.api}?ac=list`, { timeoutMs: SEARCH_TIMEOUT_MS });
		const rawClass = Array.isArray((listData as { class?: unknown } | null)?.class)
			? (listData as { class: Array<Record<string, unknown>> }).class
			: [];
		const classes: ClassItem[] = rawClass.map((c) => ({
			type_id: Number(c.type_id),
			type_name: String(c.type_name ?? ""),
		}));
		const { movieIds, tvIds } = pickCategoryIds(classes);

		const [m, t] = await Promise.all([
			movieIds.length ? fetchCategory(s, movieIds) : Promise.resolve([] as RecentItem[]),
			tvIds.length ? fetchCategory(s, tvIds) : Promise.resolve([] as RecentItem[]),
		]);
		movies.push(...m);
		tv.push(...t);

		if (movies.length === 0 && tv.length === 0) {
			const mixed = await fetchJson(`${s.api}?ac=detail&pg=1`, { timeoutMs: SEARCH_TIMEOUT_MS });
			for (const v of asList(mixed)) {
				const item = mapRow(s, v);
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
		movies: mergeByTitle(allMovies).sort(byRecency),
		tv: mergeByTitle(allTv).sort(byRecency),
	};
}

// ---- 取流：智能挑选可直连的播放组 ----
const CLOUD_SOURCE_RE =
	/qq|qiyi|iqiyi|youku|优酷|腾讯|爱奇艺|mgtv|芒果|letv|乐视|sohu|搜狐|pptv|bilibili|哔哩|xigua|网盘|magnet|百度|ed2k|网页|内置/i;

function isDirectUrl(u: string): boolean {
	return /\.m3u8|\.mp4|\.flv|\.ts($|[?#])/i.test(u);
}

function isHlsUrl(u: string): boolean {
	return /\.m3u8($|[?#])/i.test(u);
}

function parseGroup(group: string): Episode[] {
	return (group ?? "")
		.split("#")
		.map((seg) => {
			const idx = seg.indexOf("$");
			if (idx < 0) return { name: "", url: seg.trim() };
			return { name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() };
		})
		.filter((e) => /^https?:\/\//i.test(e.url));
}

/**
 * 挑选最佳播放组。
 * 修正点：原实现用 seg.split("$") 解构，地址里带 $ 的会被截断；
 * 且未优先 HLS。现在：HLS 加分、直链占比加分、云解析源降分、集数多略加分。
 */
export function pickPlayGroup(vodPlayUrl: string, vodPlayFrom?: string): Episode[] {
	const urlGroups = (vodPlayUrl ?? "").split("$$$");
	const fromGroups = (vodPlayFrom ?? "").split("$$$");
	let best: Episode[] = [];
	let bestScore = -Infinity;
	for (let i = 0; i < urlGroups.length; i++) {
		const eps = parseGroup(urlGroups[i]);
		if (eps.length === 0) continue;
		const fromName = fromGroups[i] ?? "";
		const directRatio = eps.filter((e) => isDirectUrl(e.url)).length / eps.length;
		const hlsRatio = eps.filter((e) => isHlsUrl(e.url)).length / eps.length;
		let score = directRatio + hlsRatio * 0.5;
		if (directRatio === 0) score -= 2;
		if (CLOUD_SOURCE_RE.test(fromName)) score -= 1.5;
		score += Math.min(eps.length, 100) / 1000; // 集数更全的微幅加分
		if (score > bestScore) {
			bestScore = score;
			best = eps;
		}
	}
	if (best.length === 0 && urlGroups.length > 0) best = parseGroup(urlGroups[0]);
	return best;
}

/** 把所有播放组都解出来，供前端「换线路」使用。 */
export function parseAllGroups(
	vodPlayUrl: string,
	vodPlayFrom?: string,
): Array<{ from: string; episodes: Episode[] }> {
	const urlGroups = (vodPlayUrl ?? "").split("$$$");
	const fromGroups = (vodPlayFrom ?? "").split("$$$");
	const out: Array<{ from: string; episodes: Episode[] }> = [];
	for (let i = 0; i < urlGroups.length; i++) {
		const eps = parseGroup(urlGroups[i]);
		if (eps.length === 0) continue;
		out.push({ from: (fromGroups[i] ?? `线路${i + 1}`).trim() || `线路${i + 1}`, episodes: eps });
	}
	return out;
}
