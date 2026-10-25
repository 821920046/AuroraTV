"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Player from "@/components/Player";
import ErrorBoundary from "@/components/ErrorBoundary";
import SiteHeader from "@/components/SiteHeader";
import {
	FAV_GROUP,
	FAV_KEY,
	isFav,
	parseFavs,
	serializeFavs,
	toggleFavId,
} from "@/lib/liveFavs";

// ============================================================================
// 直播页
// ----------------------------------------------------------------------------
// 布局要点：
//  - 头部改用统一的 SiteHeader（旧版这里手写了一份，与管理页重复且不一致）。
//  - 频道分组 chips 在窄屏横向滚动，而不是换行成三四排把频道网格挤下去。
//  - 切换分组时不再把整个网格替换成「加载中」，而是原地变暗 ——
//    否则每点一次分组，画面都要闪一下、滚动位置也会跳。
//  - 频道收藏：纯逻辑在 lib/liveFavs.ts（可单测），这里只负责 localStorage 读写。
// ============================================================================

type Channel = {
	id: string;
	name: string;
	group_title?: string;
	logo?: string;
	epg_id?: string;
	flags?: { sd?: boolean; geoblock?: boolean; youtube?: boolean };
};

type Group = { group: string; count: number };
type EpgItem = { start: number; stop: number; title: string };
type PlaySrc = { url: string; proxy?: string; prefer?: "direct" | "proxy" };

function fmt(ts: number) {
	return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Logo({ src, name }: { src?: string; name: string }) {
	const [bad, setBad] = useState(false);
	if (!src || bad) return <span>{name.slice(0, 2)}</span>;
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} />;
}

export default function Live() {
	const [groups, setGroups] = useState<Group[]>([]);
	const [channels, setChannels] = useState<Channel[]>([]);
	const [group, setGroup] = useState<string>("");
	const [loading, setLoading] = useState(true);
	const [q, setQ] = useState("");
	const [src, setSrc] = useState<PlaySrc | null>(null);
	const [active, setActive] = useState<Channel | null>(null);
	const [epg, setEpg] = useState<{ now?: EpgItem | null; next?: EpgItem | null }>({});
	/** 收藏的频道 id 列表 */
	const [favs, setFavs] = useState<string[]>([]);

	// 只有首次加载才显示整屏骨架；之后切分组只是让网格变暗
	const firstLoad = useRef(true);
	const playerBox = useRef<HTMLDivElement | null>(null);
	/** 盘是否已经读过。没读过之前不能落盘 —— 那会把用户的收藏清成空数组 */
	const favsLoaded = useRef(false);

	async function load(g?: string) {
		setLoading(true);
		try {
			const qs = g ? "?group=" + encodeURIComponent(g) : "";
			const r = await fetch("/api/live/channels" + qs);
			const d = (await r.json()) as { channels?: Channel[]; groups?: Group[] };
			setChannels(d.channels ?? []);
			if (d.groups && d.groups.length) setGroups(d.groups);
		} catch {
			setChannels([]);
		} finally {
			setLoading(false);
			firstLoad.current = false;
		}
	}

	useEffect(() => {
		void load();
	}, []);

	// 收藏：挂载后读盘（不能当 useState 初始值 —— 页面会被 SSR 一次，
	// 那样会造成 hydration 前后不一致，与 Player 的偏好恢复同一套理由）
	useEffect(() => {
		try {
			setFavs(parseFavs(window.localStorage.getItem(FAV_KEY)));
		} catch {
			setFavs([]);
		}
		favsLoaded.current = true;
	}, []);

	// 变更后落盘。用 effect 而不是在 setFavs 的更新函数里写盘：
	// StrictMode 下更新函数会被调用两次，副作用混进去会写两遍。
	useEffect(() => {
		if (!favsLoaded.current) return;
		try {
			window.localStorage.setItem(FAV_KEY, serializeFavs(favs));
		} catch {
			/* 隐私模式下可能写失败：收藏本次不落盘，不影响其它功能 */
		}
	}, [favs]);

	const favSet = useMemo(() => new Set(favs), [favs]);

	const toggleFav = useCallback((id: string) => {
		setFavs((prev) => toggleFavId(prev, id));
	}, []);

	async function play(ch: Channel) {
		setActive(ch);
		setEpg({});
		setSrc(null);
		// 换台后把播放器带进视野：频道网格很长，不滚过去用户会以为「点了没反应」
		setTimeout(() => playerBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
		try {
			const r = await fetch("/api/live/play?id=" + encodeURIComponent(ch.id));
			const d = (await r.json()) as PlaySrc & { code?: number };
			if (d.url) setSrc({ url: d.url, proxy: d.proxy, prefer: d.prefer ?? "proxy" });
		} catch {
			setSrc(null);
		}
		if (ch.epg_id) {
			fetch("/api/live/epg?epgId=" + encodeURIComponent(ch.epg_id))
				.then((x) => x.json())
				// 同 page.tsx：workers-types 下 Response.json() 是 unknown，需显式断言。
				.then((raw) => {
					const e = raw as { now?: EpgItem | null; next?: EpgItem | null };
					setEpg({ now: e.now, next: e.next });
				})
				.catch(() => undefined);
		}
	}

	const filtered = useMemo(() => {
		const kw = q.trim().toLowerCase();
		// 收藏是跨分组的：用户收藏的频道可能散在各组里，
		// 所以点「收藏」时 load() 拉的是全量频道，这里只做客户端过滤。
		let list = group === FAV_GROUP ? channels.filter((c) => favSet.has(c.id)) : channels;
		if (kw) list = list.filter((c) => c.name.toLowerCase().includes(kw));
		return list;
	}, [channels, q, group, favSet]);

	const showSkeleton = loading && firstLoad.current;

	return (
		<>
			<SiteHeader />

			<main className="container">
				<section className="hero">
					<h1 className="hero-title">
						现场直播<span className="grad">全球免费频道</span>
					</h1>
					<p className="hero-sub">聚合 M3U 直播源 · 探活择优 · 同源加速线路，浏览器直接看</p>
					<div className="search-bar" role="search">
						<input
							className="search-input"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder="过滤频道名称…"
							aria-label="过滤频道名称"
						/>
					</div>
				</section>

			<div ref={playerBox}>
				{src && active && (
					<div className="player-wrap">
						{/* 直播源地址质量参差，播放器崩溃时不能带走整个频道列表 */}
						<ErrorBoundary label="播放器出错了">
							<Player
								key={active.id}
								url={src.url}
								proxyUrl={src.proxy}
								prefer={src.prefer ?? "proxy"}
								title={active.name}
								sourceId={active.id}
							/>
						</ErrorBoundary>
						<div className="live-now">
								<strong>{active.name}</strong>
								{epg.now && (
									<span className="live-epg">
										正在播：{epg.now.title}（{fmt(epg.now.start)}–{fmt(epg.now.stop)}）
									</span>
								)}
								{epg.next && <span className="live-epg">稍后：{epg.next.title}</span>}
							</div>
						</div>
					)}
				</div>

			{/* 分组条：窄屏横向滚动，不换行 */}
			<div className="live-groups chips-scroll">
				{/* 收藏置顶。只有真的有时才显示 —— 否则chip 行永远多一个空项，
				    而发现入口是每张卡片左上角的 ★（一直可见）。 */}
				{favs.length > 0 && (
					<button
						type="button"
						className={"chip" + (group === FAV_GROUP ? " chip-on" : "")}
						aria-pressed={group === FAV_GROUP}
						onClick={() => {
							setGroup(FAV_GROUP);
							// 当前是分组视图时才需要重拉：收藏可能来自任何分组。
							// 已经在「全部」或「★ 收藏」就不浪费一次请求
							// （边缘缓存虽便宜，但不是免费）。
							if (group !== "" && group !== FAV_GROUP) void load();
						}}
					>
						★ 收藏 <span className="live-count">{favs.length}</span>
					</button>
				)}
				<button
					type="button"
					className={"chip" + (group === "" ? " chip-on" : "")}
					aria-pressed={group === ""}
					onClick={() => {
						setGroup("");
						void load();
					}}
				>
					全部
				</button>
					{groups.map((g) => (
						<button
							type="button"
							key={g.group}
							className={"chip" + (group === g.group ? " chip-on" : "")}
							aria-pressed={group === g.group}
							onClick={() => {
								setGroup(g.group);
								void load(g.group);
							}}
						>
							{g.group} <span className="live-count">{g.count}</span>
						</button>
					))}
				</div>

				{showSkeleton ? (
					<div className="live-grid" aria-hidden="true">
						{Array.from({ length: 12 }).map((_, i) => (
							<div className="skeleton" key={i}>
								<div style={{ aspectRatio: "1 / 1" }} className="sk-poster" />
								<div className="sk-line" />
							</div>
						))}
					</div>
			) : filtered.length === 0 ? (
				<div className="empty">
					<div className="emoji">{q ? "🔍" : group === FAV_GROUP ? "⭐" : "📺"}</div>
					<h3>
						{q ? "没有匹配的频道" : group === FAV_GROUP ? "还没有收藏" : "还没有频道"}
					</h3>
					<p>
						{q
							? "换个关键词，或点上方「全部」查看所有分组。"
							: group === FAV_GROUP
								? "点频道卡片左上角的 ★ 把常看的频道收进来，之后它会被置顶成一个分组。"
								: "到「管理」页点击「立即刷新频道」从 M3U 订阅源摄取，或等待 Cron 自动摄取。"}
					</p>
				</div>
			) : (
					<div
						className="live-grid"
						style={{ opacity: loading ? 0.5 : 1, transition: "opacity .2s ease" }}
						aria-busy={loading}
					>
					{filtered.map((ch) => {
						const fav = isFav(favs, ch.id);
						return (
							/* 外层容器只为给星标提供定位上下文：
							   星标不能嵌在 .live-card 里面 —— 它本身是 <button>，
							   button 套 button 是非法 HTML，点击行为也会变得不确定。 */
							<div className="live-cell" key={ch.id}>
								<button
									type="button"
									className={"live-card" + (active?.id === ch.id ? " is-active" : "")}
									aria-pressed={active?.id === ch.id}
									onClick={() => void play(ch)}
								>
									{ch.flags?.geoblock && <span className="live-tag">地区限</span>}
									<div className="live-logo">
										<Logo src={ch.logo} name={ch.name} />
									</div>
									<div className="live-name">{ch.name}</div>
								</button>
								<button
									type="button"
									className={"live-fav" + (fav ? " is-on" : "")}
									aria-pressed={fav}
									aria-label={(fav ? "取消收藏 " : "收藏 ") + ch.name}
									title={fav ? "取消收藏" : "收藏"}
									onClick={(e) => {
										// 必须拦住：否则点星标会顺带触发底下的播放
										e.stopPropagation();
										toggleFav(ch.id);
									}}
								>
									★
								</button>
							</div>
						);
					})}
					</div>
				)}

				<footer className="site-footer">
					AuroraTV 直播 · 频道仅聚合公开 M3U 源
					<br />
					部分源受 GeoIP 限制，即使走加速线路也可能无法播放
				</footer>
			</main>
		</>
	);
}
