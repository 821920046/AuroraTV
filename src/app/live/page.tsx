"use client";
import { useEffect, useMemo, useState } from "react";
import Player from "@/components/Player";

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
	return <img src={src} alt={name} loading="lazy" decoding="async" onError={() => setBad(true)} />;
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
		}
	}

	useEffect(() => {
		void load();
	}, []);

	async function play(ch: Channel) {
		setActive(ch);
		setEpg({});
		setSrc(null);
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
				.then((e: { now?: EpgItem | null; next?: EpgItem | null }) =>
					setEpg({ now: e.now, next: e.next }),
				)
				.catch(() => undefined);
		}
	}

	const filtered = useMemo(() => {
		const kw = q.trim().toLowerCase();
		if (!kw) return channels;
		return channels.filter((c) => c.name.toLowerCase().includes(kw));
	}, [channels, q]);

	return (
		<>
			<header className="site-header">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img className="logo-badge" src="/logo.png" alt="AuroraTV" />
				<span className="wordmark">AuroraTV</span>
				<div className="header-spacer" />
				<a className="header-link" href="/">
					点播
				</a>
				<a className="header-link" href="/admin">
					管理
				</a>
			</header>

			<main className="container">
				<section className="hero">
					<h1>
						现场直播<span className="grad">全球免费频道</span>
					</h1>
					<p>聚合 M3U 直播源 · 探活择优 · 同源加速线路，浏览器直接看</p>
					<div className="search-bar">
						<input
							className="search-input"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder="过滤频道名称…"
						/>
					</div>
				</section>

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

				<div className="live-groups">
					<button
						type="button"
						className={"chip" + (group === "" ? " chip-on" : "")}
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
							onClick={() => {
								setGroup(g.group);
								void load(g.group);
							}}
						>
							{g.group} <span className="live-count">{g.count}</span>
						</button>
					))}
				</div>

				{loading ? (
					<div className="empty">
						<div className="emoji">📡</div>
						<h3>加载频道中…</h3>
					</div>
				) : filtered.length === 0 ? (
					<div className="empty">
						<div className="emoji">📺</div>
						<h3>还没有频道</h3>
						<p>到「管理」页点击「立即刷新频道」从 M3U 订阅源摄取，或等待 Cron 自动摄取。</p>
					</div>
				) : (
					<div className="live-grid">
						{filtered.map((ch) => (
							<button type="button" key={ch.id} className="live-card" onClick={() => void play(ch)}>
								<div className="live-logo">
									<Logo src={ch.logo} name={ch.name} />
								</div>
								<div className="live-name">{ch.name}</div>
								{ch.flags?.geoblock && <span className="live-tag">地区限</span>}
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
