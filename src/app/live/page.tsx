"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Player from "@/components/Player";
import SiteHeader from "@/components/SiteHeader";

// ============================================================================
// 直播页
// ----------------------------------------------------------------------------
// 布局要点：
//  - 头部改用统一的 SiteHeader（旧版这里手写了一份，与管理页重复且不一致）。
//  - 频道分组 chips 在窄屏横向滚动，而不是换行成三四排把频道网格挤下去。
//  - 切换分组时不再把整个网格替换成「加载中」，而是原地变暗 ——
//    否则每点一次分组，画面都要闪一下、滚动位置也会跳。
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

	// 只有首次加载才显示整屏骨架；之后切分组只是让网格变暗
	const firstLoad = useRef(true);
	const playerBox = useRef<HTMLDivElement | null>(null);

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
		if (!kw) return channels;
		return channels.filter((c) => c.name.toLowerCase().includes(kw));
	}, [channels, q]);

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
							<Player
								key={active.id}
								url={src.url}
								proxyUrl={src.proxy}
								prefer={src.prefer ?? "proxy"}
								title={active.name}
								sourceId={active.id}
							/>
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
						<div className="emoji">📺</div>
						<h3>{q ? "没有匹配的频道" : "还没有频道"}</h3>
						<p>
							{q
								? "换个关键词，或点上方「全部」查看所有分组。"
								: "到「管理」页点击「立即刷新频道」从 M3U 订阅源摄取，或等待 Cron 自动摄取。"}
						</p>
					</div>
				) : (
					<div
						className="live-grid"
						style={{ opacity: loading ? 0.5 : 1, transition: "opacity .2s ease" }}
						aria-busy={loading}
					>
						{filtered.map((ch) => (
							<button
								type="button"
								key={ch.id}
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
						))}
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
