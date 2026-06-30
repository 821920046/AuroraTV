// 直播频道模块：解析 M3U 播放列表（Free-TV/IPTV、iptv-org 等）入库 D1，
// 提供频道查询、直播订阅源 CRUD、源探活评分、EPG（best-effort）。
// 纪律与点播一致：只存频道元数据与可直连地址，绝不中转视频流。
import { computeScore } from "./scoring";

export type ChannelFlags = { sd: boolean; geoblock: boolean; youtube: boolean };

export type Channel = {
	id: string;
	name: string;
	group_title?: string;
	logo?: string;
	stream_url: string;
	epg_id?: string;
	country_code?: string;
	flags: ChannelFlags;
	score?: number;
	active?: boolean;
};

export type LiveSource = {
	id: string;
	name: string;
	url: string;
	enabled?: boolean;
	// keepAll=true 的为「国内专用源」：频道整表入库，不经地区白名单过滤
	//（这类源的 group-title 多为 央视/卫视/分类名，无法用 China/Hong Kong 精确匹配）。
	keepAll?: boolean;
};

// 推荐国内源（一键添加 / 默认内置）。均为「国内专用源」keepAll=true：整表入库、不做地区过滤。
// 链接均为公开、长期维护的直连 M3U。注意：部分源为 IPv6 专用（需本机支持 IPv6），
// 无 IPv6 网络优先用 vbskycn IPv4 源。源会失效/更换，失效时可在 /admin 删除或替换。
export const RECOMMENDED_CN_SOURCES: LiveSource[] = [
	{
		id: "cn_vbskycn_ipv4",
		name: "国内聚合·vbskycn (IPv4)",
		url: "https://live.zbds.org/tv/iptv4.m3u",
		keepAll: true,
	},
	{
		id: "cn_vbskycn_ipv6",
		name: "国内聚合·vbskycn (IPv6)",
		url: "https://live.zbds.org/tv/iptv6.m3u",
		keepAll: true,
	},
	{
		id: "cn_fanmingming_ipv6",
		name: "范明明·央视卫视 (IPv6)",
		url: "https://live.fanmingming.com/tv/m3u/ipv6.m3u",
		keepAll: true,
	},
	{
		id: "cn_yang1989_gather",
		name: "YanG 聚合源 Gather",
		url: "https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u",
		keepAll: true,
	},
	{
		id: "cn_iptv_org",
		name: "iptv-org·中国",
		url: "https://iptv-org.github.io/iptv/countries/cn.m3u",
		keepAll: true,
	},
];

export const RECOMMENDED_SOURCE_IDS = new Set(RECOMMENDED_CN_SOURCES.map((s) => s.id));

// 内置默认直播订阅。仅当 live_source 表为空时作为兜底，站长可在 /admin 增删覆盖。
// Free-TV/IPTV 为全球源（按地区白名单只取国内/香港）；其余为国内专用源（keepAll）。
export const DEFAULT_LIVE_SOURCES: LiveSource[] = [
	{
		id: "free_tv_iptv",
		name: "Free-TV/IPTV",
		url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
	},
	...RECOMMENDED_CN_SOURCES,
];

// 地区白名单：用于「全球源」(如 Free-TV) 的地区过滤与「只留国内/香港」清理。
// 国内专用源(keepAll)不走这里。置为空数组 [] 表示不过滤、保留全部。
// 想加台湾/澳门只需追加 "Taiwan" / "Macau"。
export const REGION_ALLOWLIST: string[] = ["China", "Hong Kong"];

// 国内/香港常见 group-title 关键词（小写、子串匹配），覆盖多源的中文分组名，
// 让 isAllowedGroup / pruneChannels 不会误删 央视/卫视/CCTV/香港 等频道。
const REGION_KEYWORDS = [
	"china",
	"hong kong",
	"hongkong",
	"中国",
	"国内",
	"央视",
	"卫视",
	"cctv",
	"cgtn",
	"凤凰",
	"香港",
	"tvb",
	"翡翠",
	"明珠",
	"粤",
	"数字",
	"地方",
	"少儿",
	"体育",
	"电影",
	"影视",
	"综合",
	"综艺",
	"纪录",
	"教育",
	"新闻",
	"咪咕",
	"migu",
	"newtv",
	"高清",
	"4k",
];

function isAllowedGroup(group?: string | null): boolean {
	if (REGION_ALLOWLIST.length === 0) return true;
	const g = (group ?? "").trim().toLowerCase();
	if (!g) return false;
	if (REGION_ALLOWLIST.some((a) => a.trim().toLowerCase() === g)) return true;
	return REGION_KEYWORDS.some((k) => g.includes(k));
}

// Free-TV/IPTV 频道名尾部的标记：Ⓢ(非高清) Ⓖ(GeoIP) Ⓨ(YouTube)
const FLAG_RE = /[\u24c8\u24bc\u24ce]/gu;

function attr(line: string, key: string): string | undefined {
	const m = line.match(new RegExp(`${key}="([^"]*)"`));
	return m ? m[1] : undefined;
}

export function slugify(...parts: string[]): string {
	const base = parts
		.join("_")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 60);
	return base || "ch";
}

// 解析标准 M3U/M3U8 播放列表（#EXTINF 行 + 下一行地址）
export function parseM3U(text: string): Channel[] {
	const lines = text.split(/\r?\n/);
	const out: Channel[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i].trim();
		if (!l.startsWith("#EXTINF")) continue;
		// 向下找到第一行非空、非注释作为播放地址
		let url = "";
		for (let j = i + 1; j < lines.length; j++) {
			const n = lines[j].trim();
			if (!n) continue;
			if (n.startsWith("#")) continue;
			url = n;
			break;
		}
		if (!url || !/^https?:\/\//i.test(url)) continue;
		const rawName = (l.split(",").pop() ?? "").trim();
		const name = rawName.replace(FLAG_RE, "").trim();
		if (!name) continue;
		const group = attr(l, "group-title");
		let id = slugify(group ?? "", name);
		while (seen.has(id)) id += "_x";
		seen.add(id);
		out.push({
			id,
			name,
			group_title: group,
			logo: attr(l, "tvg-logo"),
			epg_id: attr(l, "tvg-id"),
			country_code: attr(l, "tvg-country"),
			stream_url: url,
			flags: {
				sd: /\u24c8/u.test(rawName),
				geoblock: /\u24bc/u.test(rawName),
				youtube: /\u24ce/u.test(rawName) || /youtube\.com/i.test(url),
			},
		});
	}
	return out;
}

// ---------------- 频道查询 ----------------

type ChannelRow = {
	id: string;
	name: string;
	group_title: string | null;
	logo: string | null;
	stream_url: string;
	epg_id: string | null;
	country_code: string | null;
	flags: string;
	score: number;
	active: number;
	updated_at: number;
};

function rowToChannel(r: ChannelRow): Channel {
	let flags: ChannelFlags = { sd: false, geoblock: false, youtube: false };
	try {
		flags = { ...flags, ...(JSON.parse(r.flags || "{}") as Partial<ChannelFlags>) };
	} catch {
		/* ignore */
	}
	return {
		id: r.id,
		name: r.name,
		group_title: r.group_title ?? undefined,
		logo: r.logo ?? undefined,
		stream_url: r.stream_url,
		epg_id: r.epg_id ?? undefined,
		country_code: r.country_code ?? undefined,
		flags,
		score: r.score,
		active: r.active !== 0,
	};
}

export async function getChannels(
	db: D1Database,
	opts: { group?: string; limit?: number; includeInactive?: boolean } = {},
): Promise<Channel[]> {
	const limit = Math.min(opts.limit ?? 1500, 3000);
	const activeClause = opts.includeInactive ? "" : " AND active = 1";
	try {
		const sql = opts.group
			? `SELECT * FROM channel WHERE group_title = ?1${activeClause} ORDER BY score DESC, name ASC LIMIT ?2`
			: `SELECT * FROM channel WHERE 1=1${activeClause} ORDER BY group_title ASC, score DESC, name ASC LIMIT ?1`;
		const stmt = opts.group
			? db.prepare(sql).bind(opts.group, limit)
			: db.prepare(sql).bind(limit);
		const { results } = await stmt.all<ChannelRow>();
		return (results ?? []).map(rowToChannel);
	} catch (e) {
		console.error("getChannels failed:", e);
		return [];
	}
}

export async function getChannelGroups(
	db: D1Database,
): Promise<Array<{ group: string; count: number }>> {
	try {
		const { results } = await db
			.prepare(
				"SELECT COALESCE(group_title,'其他') AS g, COUNT(*) AS c FROM channel WHERE active = 1 GROUP BY g ORDER BY c DESC",
			)
			.all<{ g: string; c: number }>();
		return (results ?? []).map((r) => ({ group: r.g, count: r.c }));
	} catch (e) {
		console.error("getChannelGroups failed:", e);
		return [];
	}
}

export async function getChannel(db: D1Database, id: string): Promise<Channel | null> {
	try {
		const row = await db.prepare("SELECT * FROM channel WHERE id = ?1").bind(id).first<ChannelRow>();
		return row ? rowToChannel(row) : null;
	} catch (e) {
		console.error("getChannel failed:", e);
		return null;
	}
}

// 频道「版本」：取最新 updated_at。摄取/探活后该值会变，用作缓存 key
// 的一部分，从而让 /live 列表在摄取后立即取到新数据（旧缓存自然过期）。
export async function getChannelsVersion(db: D1Database): Promise<number> {
	try {
		const row = await db
			.prepare("SELECT MAX(updated_at) AS v, COUNT(*) AS c FROM channel")
			.first<{ v: number | null; c: number }>();
		return (row?.v ?? 0) + (row?.c ?? 0);
	} catch {
		return 0;
	}
}

export async function getChannelCount(db: D1Database): Promise<number> {
	try {
		const row = await db
			.prepare("SELECT COUNT(*) AS c, SUM(active) AS a FROM channel")
			.first<{ c: number; a: number }>();
		return row?.c ?? 0;
	} catch {
		return 0;
	}
}

// ---------------- 摄取（M3U -> D1） ----------------

export async function ingestChannels(
	db: D1Database,
	sources: LiveSource[],
): Promise<{ sources: number; channels: number }> {
	const now = Date.now();
	let okSources = 0;
	let totalCh = 0;
	for (const src of sources) {
		if (src.enabled === false) continue;
		let text = "";
		try {
			const res = await fetch(src.url, { cf: { cacheTtl: 300 } } as RequestInit);
			if (!res.ok) continue;
			text = await res.text();
		} catch (e) {
			console.error("ingest fetch failed:", src.url, e);
			continue;
		}
		// 国内专用源(keepAll)整表入库；其余全球源按地区白名单只取国内/香港
		const keepAll = src.keepAll === true || RECOMMENDED_SOURCE_IDS.has(src.id);
		const channels = keepAll
			? parseM3U(text)
			: parseM3U(text).filter((c) => isAllowedGroup(c.group_title));
		if (channels.length === 0) continue;
		okSources++;
		for (let i = 0; i < channels.length; i += 50) {
			const batch = channels.slice(i, i + 50).map((c) =>
				db
					.prepare(
						`INSERT INTO channel (id,name,group_title,logo,stream_url,epg_id,country_code,flags,active,updated_at)
						 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)
						 ON CONFLICT(id) DO UPDATE SET
						   name=?2, group_title=?3, logo=?4, stream_url=?5, epg_id=?6,
						   country_code=?7, flags=?8, updated_at=?9`,
					)
					.bind(
						c.id,
						c.name,
						c.group_title ?? null,
						c.logo ?? null,
						c.stream_url,
						c.epg_id ?? null,
						c.country_code ?? null,
						JSON.stringify(c.flags),
						now,
					),
			);
			try {
				await db.batch(batch);
				totalCh += batch.length;
			} catch (e) {
				console.error("ingest batch failed:", e);
			}
		}
	}
	return { sources: okSources, channels: totalCh };
}

// ---------------- 探活 + 评分（复用 scoring 公式） ----------------

export async function probeChannels(
	db: D1Database,
	batchSize = 50,
): Promise<{ probed: number; alive: number }> {
	let probed = 0;
	let alive = 0;
	let rows: Array<{ id: string; stream_url: string }> = [];
	try {
		const res = await db
			.prepare("SELECT id, stream_url FROM channel ORDER BY updated_at ASC LIMIT ?1")
			.bind(batchSize)
			.all<{ id: string; stream_url: string }>();
		rows = res.results ?? [];
	} catch (e) {
		console.error("probeChannels query failed:", e);
		return { probed: 0, alive: 0 };
	}
	const now = Date.now();
	await Promise.allSettled(
		rows.map(async (ch) => {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), 4000);
			const start = Date.now();
			let ok = false;
			try {
				const r = await fetch(ch.stream_url, {
					signal: ctrl.signal,
					headers: { Range: "bytes=0-1" },
				});
				ok = r.ok || r.status === 206;
			} catch {
				ok = false;
			} finally {
				clearTimeout(t);
			}
			const latency = Date.now() - start;
			const score = computeScore({
				successRate: ok ? 1 : 0,
				avgLatencyMs: latency,
				timeouts: ok ? 0 : 1,
			});
			probed++;
			if (ok) alive++;
			try {
				await db
					.prepare("UPDATE channel SET score=?2, active=?3, updated_at=?4 WHERE id=?1")
					.bind(ch.id, score, ok ? 1 : 0, now)
					.run();
			} catch (e) {
				console.error("probe update failed:", ch.id, e);
			}
		}),
	);
	return { probed, alive };
}

// ---------------- ���播订阅源 CRUD ----------------

type LiveSourceRow = { id: string; name: string; url: string; enabled: number };

export async function getLiveSources(db: D1Database): Promise<LiveSource[]> {
	try {
		const { results } = await db
			.prepare("SELECT id, name, url, enabled FROM live_source ORDER BY name ASC")
			.all<LiveSourceRow>();
		if (!results || results.length === 0) return DEFAULT_LIVE_SOURCES;
		return results.map((r) => ({ id: r.id, name: r.name, url: r.url, enabled: r.enabled !== 0 }));
	} catch (e) {
		console.error("getLiveSources failed:", e);
		return DEFAULT_LIVE_SOURCES;
	}
}

export async function getEnabledLiveSources(db: D1Database): Promise<LiveSource[]> {
	const all = await getLiveSources(db);
	return all.filter((s) => s.enabled !== false);
}

export async function upsertLiveSource(db: D1Database, s: LiveSource): Promise<void> {
	await db
		.prepare(
			`INSERT INTO live_source (id, name, url, enabled, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(id) DO UPDATE SET name=?2, url=?3, enabled=?4`,
		)
		.bind(s.id, s.name, s.url, s.enabled === false ? 0 : 1, Date.now())
		.run();
}

export async function setLiveSourceEnabled(
	db: D1Database,
	id: string,
	enabled: boolean,
): Promise<void> {
	await db.prepare("UPDATE live_source SET enabled = ?2 WHERE id = ?1").bind(id, enabled ? 1 : 0).run();
}

export async function deleteLiveSource(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM live_source WHERE id = ?1").bind(id).run();
}

// 一次性清理：删除不在白名单地区的已入库频道，返回删除数量。
export async function pruneChannels(db: D1Database): Promise<number> {
	if (REGION_ALLOWLIST.length === 0) return 0;
	const exact = REGION_ALLOWLIST.map((a) => a.trim().toLowerCase());
	const exactClause = exact.map(() => "LOWER(TRIM(group_title)) = ?").join(" OR ");
	const likeClause = REGION_KEYWORDS.map(() => "LOWER(group_title) LIKE ?").join(" OR ");
	// 保留：精确命中白名单 或 分组名含国内/香港关键词；其余（含 NULL 分组）删除
	const keep = `(${exactClause} OR ${likeClause})`;
	const res = await db
		.prepare(`DELETE FROM channel WHERE group_title IS NULL OR NOT ${keep}`)
		.bind(...exact, ...REGION_KEYWORDS.map((k) => "%" + k + "%"))
		.run();
	const meta = (res as unknown as { meta?: { changes?: number } }).meta;
	return meta?.changes ?? 0;
}

export async function clearChannels(db: D1Database): Promise<number> {
	const res = await db.prepare("DELETE FROM channel").run();
	const meta = (res as unknown as { meta?: { changes?: number } }).meta;
	return meta?.changes ?? 0;
}

// ---------------- EPG（best-effort，可选） ----------------

export type EpgItem = { start: number; stop: number; title: string };

function parseXmltvTime(s: string): number | null {
	const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
	if (!m) return null;
	let ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	if (m[7]) {
		const sign = m[7][0] === "-" ? 1 : -1; // 本地时间 -> UTC
		ts += sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000;
	}
	return Math.floor(ts / 1000);
}

// 拉取 XMLTV（支持 .gz）并写入未来窗口内的节目。规模有上限，超限即停，避免烧 CPU。
export async function ingestEpg(
	db: D1Database,
	urls: string[],
	windowHours = 48,
): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const minTs = now - 3 * 3600;
	const maxTs = now + windowHours * 3600;
	let written = 0;
	for (const url of urls) {
		let xml = "";
		try {
			const res = await fetch(url);
			if (!res.ok) continue;
			if (url.endsWith(".gz") && res.body && typeof DecompressionStream !== "undefined") {
				const ds = new DecompressionStream("gzip");
				xml = await new Response(res.body.pipeThrough(ds)).text();
			} else {
				xml = await res.text();
			}
		} catch (e) {
			console.error("epg fetch failed:", url, e);
			continue;
		}
		const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
		const rows: Array<{ ch: string; st: number; sp: number; title: string }> = [];
		let m: RegExpExecArray | null;
		while ((m = progRe.exec(xml))) {
			const a = m[1];
			const start = a.match(/start="([^"]+)"/)?.[1];
			const stop = a.match(/stop="([^"]+)"/)?.[1];
			const ch = a.match(/channel="([^"]+)"/)?.[1];
			if (!start || !ch) continue;
			const st = parseXmltvTime(start);
			const sp = stop ? parseXmltvTime(stop) : st != null ? st + 1800 : null;
			if (st == null || sp == null) continue;
			if (sp < minTs || st > maxTs) continue;
			const title =
				m[2]
					.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]
					?.replace(/<[^>]+>/g, "")
					.trim() ?? "";
			rows.push({ ch, st, sp, title });
			if (rows.length >= 6000) break; // 安全上限
		}
		for (let i = 0; i < rows.length; i += 50) {
			const batch = rows.slice(i, i + 50).map((r) =>
				db
					.prepare(
						`INSERT INTO epg_programme (epg_id,start_ts,stop_ts,title) VALUES (?1,?2,?3,?4)
						 ON CONFLICT(epg_id,start_ts) DO UPDATE SET stop_ts=?3, title=?4`,
					)
					.bind(r.ch, r.st, r.sp, r.title),
			);
			try {
				await db.batch(batch);
				written += batch.length;
			} catch (e) {
				console.error("epg batch failed:", e);
			}
		}
	}
	try {
		await db.prepare("DELETE FROM epg_programme WHERE stop_ts < ?1").bind(minTs).run();
	} catch {
		/* ignore */
	}
	return written;
}

export async function getEpgNowNext(
	db: D1Database,
	epgId: string,
): Promise<{ now?: EpgItem; next?: EpgItem }> {
	const ts = Math.floor(Date.now() / 1000);
	try {
		const { results } = await db
			.prepare(
				"SELECT start_ts, stop_ts, title FROM epg_programme WHERE epg_id=?1 AND stop_ts>=?2 ORDER BY start_ts ASC LIMIT 4",
			)
			.bind(epgId, ts)
			.all<{ start_ts: number; stop_ts: number; title: string }>();
		const items: EpgItem[] = (results ?? []).map((r) => ({
			start: r.start_ts,
			stop: r.stop_ts,
			title: r.title,
		}));
		return {
			now: items.find((it) => it.start <= ts && it.stop > ts),
			next: items.find((it) => it.start > ts),
		};
	} catch (e) {
		console.error("getEpgNowNext failed:", e);
		return {};
	}
}
