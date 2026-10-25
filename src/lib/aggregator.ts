// 相对路径一律带 .ts 扩展名：Node 测试运行器（node --test）按 ESM 规则解析，
// 不带扩展名会 ERR_MODULE_NOT_FOUND。tsconfig 已开 allowImportingTsExtensions。
// 与 src/lib/secret.ts 的做法保持一致。
import type { VideoSource } from "./sources.ts";
import type { SourceHealth } from "./db.ts";
import { fetchJson, fetchWithTimeout, parseJsonLoose, upstreamHeaders } from "./http.ts";

// Cloudflare 免费版单请求子请求上限 50。搜索扇出给到 8，剩余额度留给 D1 / 缓存 / 重试。
const MAX_FANOUT = 8;
const SEARCH_TIMEOUT_MS = 5000;
const DETAIL_TIMEOUT_MS = 9000;

/**
 * alts 的条数上限。
 *
 * 【为什么要有上限】搜索一次最多回 120 条，每条最多带 8 个 alts，
 * 每个 alt 约 70 字节 —— 不设上限时热门关键词能把响应撑到几十 KB，
 * 而用户抱怨的正是手机端加载慢。自动换源试 8 个备用源已覆盖绝大多数情况。
 *
 * 【因此必须有 source_count】截断之后 alts.length 就不再等于真实源数，
 * 前端角标若照 alts.length + 1 显示，同名片超过 9 个源时就开始说谎
 * （显示「9 源」实际有 12 个）。真实数字单独走一个字段。
 */
const ALTS_CAP = 8;

export type SearchItem = {
	source_id: string;
	source_name?: string;
	vod_id: string;
	title: string;
	poster?: string;
	year?: number;
	remarks?: string;
	type_name?: string;
	/** 同一部片在其它源上的副本，用于前端「一键换源」。最多 ALTS_CAP 条 */
	alts?: Array<{ source_id: string; source_name?: string; vod_id: string }>;
	/**
	 * 这部片实际存在于多少个源上（含主源），不受 ALTS_CAP 限制。
	 * 角标用它显示，避免被 alts 的截断上限骗到。
	 */
	source_count?: number;
};

export type Episode = { name: string; url: string };

// 排序：网页可直连（cors=1）优先 -> 健康评分 -> 静态权重。
// 注意：自从上了同源代理，cors=0 的源也能播，因此不再「过滤掉」，只做「降权」。
// 导出只为单测（见 aggregator.test.mts）
export function pickSources(
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

/**
 * 归一化标题，用于跨源合并同一部片（去空白 / 括号 / 副标题）
 *
 * 【为什么要有这一套】各家采集站对同一部片的命名习惯不同：
 * `庆余年`、`【庆余年】`、`庆余年 (2019)`、`庆余年-第2季` 指的是同一部片。
 * 不归一化就会出现「同名影片分散成四五张卡」，换源也就无从谈起。
 *
 * 括号要成对处理：`【】` 在 MacCMS 片名里几乎无处不在（`【2024】xxx` 这种标注），
 * 漏掉它等于最常见的装饰字符没被抹掉。分隔符同理。
 */
export function titleKey(it: SearchItem): string {
	const t = it.title
		.toLowerCase()
		.replace(/[\s\u3000]+/g, "")
		.replace(/[\[\]\uff08\uff09()《》【】>:：\-_.]/g, "");
	return t + "|" + (it.year ?? "");
}

/**
 * 跨源合并：同名同年份的只保留一张卡，但把其它源存进 alts。
 * 原实现直接丢弃重复项 -> 一旦首选源挂了就彻底无法播放，现在可以自动换源。
 *
 * alts 截断在 ALTS_CAP 条，但 source_count 记的是真实源数 ——
 * 前端角标报的是「这部片在多少个源上」，不是「我随身带了几条备用线路」。
 *
 * 导出只为单测（见 aggregator.test.mts）
 */
export function mergeByTitle(items: SearchItem[]): SearchItem[] {
	const map = new Map<string, SearchItem>();
	// 每个合并组出现过的 source_id 集合，用来算真实源数
	const seen = new Map<string, Set<string>>();
	for (const it of items) {
		if (!it.title || !it.vod_id) continue;
		const k = titleKey(it);
		const prev = map.get(k);
		if (!prev) {
			map.set(k, { ...it, alts: [] });
			seen.set(k, new Set([it.source_id]));
			continue;
		}
		if (!prev.poster && it.poster) prev.poster = it.poster;
		if (!prev.remarks && it.remarks) prev.remarks = it.remarks;
		seen.get(k)?.add(it.source_id);
		if (prev.source_id !== it.source_id) {
			prev.alts = prev.alts ?? [];
			if (prev.alts.length < ALTS_CAP)
				prev.alts.push({
					source_id: it.source_id,
					source_name: it.source_name,
					vod_id: it.vod_id,
				});
		}
	}
	for (const [k, it] of map) {
		it.source_count = seen.get(k)?.size ?? 1;
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
