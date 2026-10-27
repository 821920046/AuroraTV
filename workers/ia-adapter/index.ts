/**
 * Internet Archive → MacCMS 适配 Worker
 *
 * AuroraTV 的点播侧只说 MacCMS 协议（`?ac=detail&wd=` / `?ac=detail&ids=` /
 * `?ac=list` / `?ac=detail&t=`），Internet Archive 讲的是另一套。这个 Worker
 * 做翻译，让公共版权影片能作为一个普通片源加进 AuroraTV 后台。
 *
 * 【为什么默认只收 silent_films】实测过五个合集的头部内容（按下载量排序）：
 *   silent_films    3522 项  《歌剧魅影》1925、《海底两万里》1916、《卡里加里博士》1919、
 *                            卓别林《当铺》、《战舰波将金号》1925 —— 影史经典
 *   SciFi_Horror     950 项  有《House on Haunted Hill》1959，但也混了 exploitation 片
 *   short_films    3137 项  ❌ 头部就是色情 exploitation 片（"stag film" 等），绝不能收录
 *   prelinger      10461 项  科教/工业片（《About Bananas》1935），不是给人看的
 *   feature_films 28528 项  ❌ 噪声极大，头部是各语言版《耶稣传》
 * 所以默认只开 silent_films。想加合集用 `IA_COLLECTIONS` 覆盖，
 * 但**先自己去 advancedsearch 看看那个合集的头部内容再开** —— Internet Archive
 * 没有内容分级过滤，`short_films` 这类合集会把不该出现的东西带进你的站点。
 *
 * 【请求配额】AuroraTV 的 cron 体检会打 `?ac=list`（每源 2 次）。列表/搜索端点
 * 每个只发 1 次上游请求；只有 `?ac=detail&ids=`（用户点开某部片）才拉 metadata。
 * 上游响应按 TTL 缓存（search 5min / list 1h / metadata 24h），
 * 所以高频搜索不会把 Internet Archive 打疼。
 */

export interface Env {
	/**
	 * 覆盖默认合集。格式：`显示名:collection_id,显示名:collection_id`
	 * 例：`经典电影:silent_films,恐怖影片:SciFi_Horror`
	 * 不填则只用 silent_films。
	 */
	IA_COLLECTIONS?: string;
}

// ---------------------------------------------------------------- 配置

export type Collection = { type_id: number; type_name: string; collection: string };

const DEFAULT_COLLECTIONS: Collection[] = [
	{ type_id: 1, type_name: "经典电影", collection: "silent_films" },
];

/** 列表每页条数 */
const PAGE_ROWS = 24;
/** 搜索返回条数（多合集时均分） */
const SEARCH_ROWS = 30;
/**
 * 可接受的最大单文件体积。silent_films 的 512Kb MPEG4 约 460MB/106 分钟；
 * 设上限是防某些合集的 4K 重制版把带宽和 Worker CPU 吃穿。
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** 上游缓存 TTL（秒） */
const TTL = { search: 300, list: 3600, meta: 86400 };

const UA = "AuroraTV-IA-Adapter/1.0 (+https://github.com/821920046/AuroraTV)";

/** 缓存键的合成 host。理由见 iaFetch 的注释 2。 */
const CACHE_HOST = "cache.ia-adapter.internal";

/**
 * caches.default 是 Cloudflare 专有扩展，某些运行时的标准 CacheStorage 里
 * 没有这个属性，必须先判空再用（与 src/lib/cache.ts 同一套写法）。
 */
function getDefaultCache(): Cache | null {
	try {
		const c = (caches as unknown as { default?: Cache }).default;
		return c ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- Internet Archive 类型

export type IaDoc = {
	identifier?: unknown;
	title?: unknown;
	year?: unknown;
	downloads?: unknown;
};

type IaSearchResp = { response?: { docs?: unknown } };

type IaFile = { name?: unknown; format?: unknown; size?: unknown; length?: unknown };

export type IaMeta = {
	metadata?: unknown;
	files?: unknown;
};

// ---------------------------------------------------------------- 小工具
// 以下纯函数导出只为单测（见 index.test.mts）。Worker 入口只认 default 导出，
// 普通函数导出不影响部署。

export function str(v: unknown): string {
	return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function num(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// 适配层自己不缓存响应 —— 上游缓存已经在 iaFetch 里做了。
			"cache-control": "no-store",
		},
	});
}

/**
 * 带 Cache API 缓存的上游请求。
 *
 * 四个细节：
 * 1) 必须把 body 读完再 put —— 只存响应头不读 body，Worker 可能提前中止下载，
 *    缓存里留下一个空壳（AuroraTV 的下一集预热踩过同样的坑）。
 * 2) 缓存键用合成 host 而不是直接拿上游 URL —— Cloudflare 的边缘缓存键含查询串，
 *    直接用上游 URL 当键会遇到规范化差异（项目 lib/cache.ts 同一套理由）。
 * 3) Cache API 拿不到就跳过缓存，不影响功能。
 * 4) 上游失败返回 null 而不是抛 —— 调用方退化成空列表，AuroraTV 的
 *    Promise.allSettled 会把「这个源没结果」当成正常情况处理。
 */
async function iaFetch(url: string, ttl: number, ctx: ExecutionContext): Promise<Response | null> {
	try {
		const cache = getDefaultCache();
		const key = new Request("https://" + CACHE_HOST + "/" + encodeURIComponent(url));
		if (cache) {
			const hit = await cache.match(key);
			if (hit) return hit;
		}

		const upstream = await fetch(url, { headers: { "user-agent": UA } });
		if (!upstream.ok) return null;
		const body = await upstream.text();

		const headers = new Headers({
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=" + ttl,
		});
		const res = new Response(body, { status: 200, headers });
		if (cache) ctx.waitUntil(cache.put(key, res.clone()));
		return res;
	} catch {
		return null;
	}
}

export async function readJson<T>(res: Response | null): Promise<T | null> {
	if (!res) return null;
	try {
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- 上游请求

/**
 * 清洗搜索关键词。
 *
 * AuroraTV 把用户输入原样透传，而 Internet Archive 的查询语法里
 * `: ( ) " + - && || ! [ ] { } ~ * ? \` 全都有特殊含义。用户随手敲一个
 * `foo)` 或 `title:x` 就会让整个查询失效 —— 而这个源会**静默返回空列表**，
 * 表现为「公共版权搜不到、别的源能搜到」，极难排查。
 *
 * 所以只保留字母、数字、空格、连字符、下划线（含 CJK），其余一律换成分号，
 * 再压掉连续空格。顺带限制长度，防超长关键词撑出巨型查询。
 */
export function sanitizeKeyword(kw: string): string {
	return kw
		.replace(/[^\p{L}\p{N}\s_-]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100);
}

export function searchUrl(collection: string, keyword: string, start: number, rows: number): string {
	const kw = sanitizeKeyword(keyword);
	const q = kw
		? "mediatype:movies AND collection:" + collection + " AND (" + kw + ")"
		: "mediatype:movies AND collection:" + collection;
	const u = new URL("https://archive.org/advancedsearch.php");
	u.searchParams.set("q", q);
	// 与实测通过的 URL 形状保持一致：多个 fl[] 参数 + sort[]
	for (const f of ["identifier", "title", "year", "downloads"]) u.searchParams.append("fl[]", f);
	u.searchParams.append("sort[]", "downloads desc");
	u.searchParams.set("rows", String(rows));
	u.searchParams.set("start", String(start));
	u.searchParams.set("output", "json");
	return u.toString();
}

async function searchDocs(
	collection: string,
	keyword: string,
	start: number,
	rows: number,
	ctx: ExecutionContext,
): Promise<IaDoc[]> {
	const data = await readJson<IaSearchResp>(
		await iaFetch(searchUrl(collection, keyword, start, rows), keyword ? TTL.search : TTL.list, ctx),
	);
	const docs = data?.response?.docs;
	if (!Array.isArray(docs)) return [];
	return docs.filter((d): d is IaDoc => !!d && typeof d === "object" && typeof d.identifier === "string");
}

async function fetchMeta(id: string, ctx: ExecutionContext): Promise<IaMeta | null> {
	const url = "https://archive.org/metadata/" + encodeURIComponent(id);
	return readJson<IaMeta>(await iaFetch(url, TTL.meta, ctx));
}

// ---------------------------------------------------------------- 选文件

type PickedFile = { name: string; length?: number };

/**
 * 可播放的编码/容器。
 *
 * archive.org 的派生档有两种命名：`512Kb MPEG4` 与 `h.264 IA`，两种都要认。
 * 刻意【不】收 `MPEG2` —— 实测那是上传的原片（`house_on_haunted_hill.mp4`
 * 844MB/640x480），体积大且 MPEG-2 在浏览器里基本不可靠。
 */
const PLAYABLE_RE = /MPEG4|h\.?264/i;

/**
 * 从 metadata.files 里挑一个浏览器能播的文件。
 *
 * 偏好顺序：512Kb MPEG4 / h.264 > 256Kb MPEG4 > 其它可播格式（按体积取最大）。
 * MPEG4 是 Internet Archive 的标准 h.264 派生档，`<video>` 直接吃。
 * Ogg Video 只在没有可播格式时兜底 —— Safari 播不了 ogv。
 */
export function pickVideoFile(files: unknown): PickedFile | null {
	if (!Array.isArray(files)) return null;

	type Cand = { name: string; format: string; size: number; length?: number };
	const cands: Cand[] = [];
	let ogg: PickedFile | null = null;

	for (const f of files) {
		if (!f || typeof f !== "object") continue;
		const o = f as IaFile;
		const name = str(o.name);
		if (!name) continue;
		const format = str(o.format).trim();
		const size = num(o.size) ?? 0;
		const length = num(o.length);

		if (PLAYABLE_RE.test(format)) {
			if (size > 0 && size <= MAX_FILE_BYTES) cands.push({ name, format, size, length });
		} else if (!ogg && /Ogg Video/i.test(format)) {
			ogg = { name, length };
		}
	}

	if (cands.length) {
		const rank = (fmt: string) =>
			fmt === "512Kb MPEG4" || /h\.?264/i.test(fmt) ? 3 : fmt === "256Kb MPEG4" ? 2 : 1;
		cands.sort((a, b) => rank(b.format) - rank(a.format) || b.size - a.size);
		return { name: cands[0].name, length: cands[0].length };
	}
	return ogg;
}

/** archive.org 的下载地址。id 与文件名都可能带需要编码的字符。 */
export function downloadUrl(id: string, file: string): string {
	const segs = file.split("/").map(encodeURIComponent).join("/");
	return "https://archive.org/download/" + encodeURIComponent(id) + "/" + segs;
}

export function posterUrl(id: string): string {
	return "https://archive.org/services/img/" + encodeURIComponent(id);
}

// ---------------------------------------------------------------- MacCMS 行映射

/** 列表/搜索用的「便宜行」—— 不拉 metadata，只发 1 次上游请求。 */
export function toRow(coll: Collection, d: IaDoc): Record<string, unknown> {
	const id = str(d.identifier);
	return {
		vod_id: id,
		vod_name: str(d.title) || id,
		vod_pic: posterUrl(id),
		vod_year: num(d.year) ?? "",
		type_id: coll.type_id,
		type_name: coll.type_name,
	};
}

/** 详情行 —— 带上 vod_play_url，AuroraTV 只有点开某部片时才走这里。 */
export function toDetailRow(coll: Collection, d: IaDoc, meta: IaMeta | null): Record<string, unknown> {
	const row = toRow(coll, d);
	const picked = meta ? pickVideoFile(meta.files) : null;
	if (picked) {
		row.vod_play_from = "archive.org";
		row.vod_play_url = "正片$" + downloadUrl(str(d.identifier), picked.name);
		// 时长做成角标（分钟）。没有 length 就不设，UI 会优雅跳过。
		if (picked.length && picked.length > 60) {
			row.vod_remarks = Math.round(picked.length / 60) + " 分钟";
		}
	}
	return row;
}

/** 从 metadata 里还原出搜索文档形状，供详情端点复用。 */
export function metaToDoc(id: string, meta: IaMeta | null): IaDoc {
	const m = meta?.metadata;
	if (!m || typeof m !== "object") return { identifier: id };
	const o = m as Record<string, unknown>;
	return {
		identifier: str(o.identifier) || id,
		title: o.title,
		year: o.year,
	};
}

/** 详情端点要知道这片属于哪个合集，才能填对 type_name。 */
export function resolveCollection(cols: Collection[], meta: IaMeta | null): Collection {
	const m = meta?.metadata;
	const raw = m && typeof m === "object" ? (m as Record<string, unknown>).collection : undefined;
	const names = Array.isArray(raw) ? raw.map(str) : [str(raw)];
	for (const c of cols) if (names.includes(c.collection)) return c;
	return cols[0];
}

// ---------------------------------------------------------------- 端点处理

function handleList(cols: Collection[], ctx: ExecutionContext) {
	const primary = cols[0];
	return searchDocs(primary.collection, "", 0, PAGE_ROWS, ctx).then((docs) => ({
		code: 1,
		// AuroraTV 的 aggregateRecent 靠 class[] 决定首页「电影」行取哪些分类。
		// type_name 必须含「电影/影片/片」才会被算进电影行。
		class: cols.map((c) => ({ type_id: c.type_id, type_name: c.type_name })),
		list: docs.map((d) => toRow(primary, d)),
	}));
}

function handleSearch(cols: Collection[], keyword: string, ctx: ExecutionContext) {
	// 用清洗后的词做相关度排序，与真正发给上游的查询保持一致。
	// 词被清成空串时（用户只敲了标点）不退化成空结果 —— 上游会按下载量返回热门片，
	// 比「这个源永远搜不到」更容易理解。
	const kw = sanitizeKeyword(keyword);
	const per = Math.max(1, Math.ceil(SEARCH_ROWS / cols.length));
	return Promise.all(
		cols.map((c) => searchDocs(c.collection, kw, 0, per, ctx).then((ds) => ds.map((d) => toRow(c, d)))),
	).then((lists) => {
		const list = lists.flat();
		if (kw) {
			// Internet Archive 按下载量排序，与关键词相关度无关。
			// 做一次轻量重排：标题完全相等 > 前缀 > 包含。
			// Array.sort 在现代引擎里稳定，同分保持下载量顺序。
			const k = kw.toLowerCase();
			const score = (row: Record<string, unknown>) => {
				const n = String(row.vod_name ?? "").toLowerCase();
				if (n === k) return 3;
				if (n.startsWith(k)) return 2;
				if (n.includes(k)) return 1;
				return 0;
			};
			list.sort((a, b) => score(b) - score(a));
		}
		return { code: 1, list };
	});
}

/** `?ac=detail&t=<type_id>&pg=<n>`，以及无 t 时的 `?ac=detail&pg=<n>` 兜底。 */
function handlePage(cols: Collection[], typeId: string | null, page: number, ctx: ExecutionContext) {
	const coll = cols.find((c) => String(c.type_id) === String(typeId)) ?? cols[0];
	const pg = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
	const start = (pg - 1) * PAGE_ROWS;
	return searchDocs(coll.collection, "", start, PAGE_ROWS, ctx).then((docs) => ({
		code: 1,
		list: docs.map((d) => toRow(coll, d)),
	}));
}

/** `?ac=detail&ids=<vod_id>` —— 唯一需要拉 metadata 的端点。 */
function handleDetail(cols: Collection[], idsRaw: string, ctx: ExecutionContext) {
	// AuroraTV 只传单个 id；容忍逗号分隔取第一个。
	const id = idsRaw.split(",")[0].trim();
	if (!id) return Promise.resolve({ code: 0, list: [] });
	return fetchMeta(id, ctx).then((meta) => {
		const doc = metaToDoc(id, meta);
		const coll = resolveCollection(cols, meta);
		return { code: 1, list: [toDetailRow(coll, doc, meta)] };
	});
}

// ---------------------------------------------------------------- 入口

export function parseCollections(raw: string | undefined): Collection[] {
	if (!raw || !raw.trim()) return DEFAULT_COLLECTIONS;
	const out: Collection[] = [];
	for (const seg of raw.split(",")) {
		const s = seg.trim();
		if (!s) continue;
		// 显示名可能含冒号，从右边切
		const idx = s.lastIndexOf(":");
		const name = idx > 0 ? s.slice(0, idx).trim() : s;
		const coll = idx > 0 ? s.slice(idx + 1).trim() : s;
		if (!coll) continue;
		out.push({ type_id: out.length + 1, type_name: name || coll, collection: coll });
	}
	return out.length ? out : DEFAULT_COLLECTIONS;
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);

		if (req.method !== "GET" && req.method !== "HEAD") {
			return json({ code: 0, msg: "method not allowed" }, 405);
		}

		const cols = parseCollections(env.IA_COLLECTIONS);
		const ac = url.searchParams.get("ac") ?? "";

		try {
			if (ac === "list") {
				return json(await handleList(cols, ctx));
			}
			if (ac === "detail") {
				const wd = url.searchParams.get("wd");
				if (wd !== null) return json(await handleSearch(cols, wd, ctx));

				const ids = url.searchParams.get("ids");
				if (ids !== null) return json(await handleDetail(cols, ids, ctx));

				return json(await handlePage(cols, url.searchParams.get("t"), num(url.searchParams.get("pg")) ?? 1, ctx));
			}
			// 未知 ac：返回空列表而不是报错，AuroraTV 会把这个源当成「没有结果」
			return json({ code: 0, list: [] });
		} catch {
			// 兜底：任何异常都退化成空列表，绝不让片源把整站搜索带崩
			return json({ code: 0, list: [] });
		}
	},
};
