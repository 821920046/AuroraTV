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

function fmt(ts: number) {
	return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function Live() {
	const [groups, setGroups] = useState<Group[]>([]);
	const [channels, setChannels] = useState<Channel[]>([]);
	const [group, setGroup] = useState<string>("");
	const [loading, setLoading] = useState(true);
	const [q, setQ] = useState("");
	const [playUrl, setPlayUrl] = useState<string | null>(null);
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
		load();
	}, []);

	async function play(ch: Channel) {
		setActive(ch);
		setEpg({});
		const r = await fetch("/api/live/play?id=" + encodeURIComponent(ch.id));
		const d = (await r.json()) as { url?: string };
		if (d.url) setPlayUrl(d.url);
		if (ch.epg_id) {
			fetch("/api/live/epg?epgId=" + encodeURIComponent(ch.epg_id))
				.then((x) => x.json())
				.then((e: { now?: EpgItem | null; next?: EpgItem | null }) =>
					setEpg({ now: e.now, next: e.next }),
				)
				.catch(() => {});
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
				<a className="header-link" href="/">点播</a>
				<a className="header-link" href="/admin">管理</a>
			</header>

			<main className="container">
				<section className="hero">
					<h1>
						现场直播<span className="grad">全球免费频道</span>
					</h1>
					<p>聚合 M3U 直播源 · 探活择优 · 客户端直连 HLS</p>
					<div className="search-bar">
						<input
							className="search-input"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder="过滤频道名称…"
						/>
					</div>
				</section>

				{playUrl && active && (
					<div className="player-wrap">
						<Player url={playUrl} sourceId={active.id} onAllFailed={() => setPlayUrl(null)} />
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
						className={"chip" + (group === "" ? " chip-on" : "")}
						onClick={() => {
							setGroup("");
							load();
						}}
					>
						全部
					</button>
					{groups.map((g) => (
						<button
							key={g.group}
							className={"chip" + (group === g.group ? " chip-on" : "")}
							onClick={() => {
								setGroup(g.group);
								load(g.group);
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
							<button key={ch.id} className="live-card" onClick={() => play(ch)}>
								<div className="live-logo">
									{ch.logo ? (
										// eslint-disable-next-line @next/next/no-img-element
									<img src={ch.logo} alt={ch.name} loading="lazy" />
									) : (
										<span>{ch.name.slice(0, 2)}</span>
									)}
								</div>
								<div className="live-name">{ch.name}</div>
								{ch.flags?.geoblock && <span className="live-tag">地区限</span>}
							</button>
						))}
					</div>
				)}

				<footer className="site-footer">
					AuroraTV 直播 · 频道仅聚合公开 M3U 源，视频流由客户端直连
					<br />
					部分源受 GeoIP 限制，国内可能需代理才能播放
				</footer>
			</main>
		</>
	);
}
