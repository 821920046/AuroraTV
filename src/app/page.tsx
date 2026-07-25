"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Player from "@/components/Player";

// ============================================================================
// 首页：搜索 -> 选片 -> 选集 -> 播放
// 升级点：
//  - 真正的剧集列表（旧版接口返回了 episodes 却从未展示，只能看第一集）
//  - 一键换源（搜索结果合并的 alts）与换线路（vod_play_from 分组）
//  - 观看进度记忆 + 继续观看
//  - 请求可中断（连续搜索不会互相覆盖）
// ============================================================================

type Item = {
	source_id: string;
	source_name?: string;
	vod_id: string;
	title: string;
	poster?: string | null;
	year?: number;
	remarks?: string;
	type_name?: string;
	alts?: Array<{ source_id: string; source_name?: string; vod_id: string }>;
};

type Episode = { name: string; url: string; proxy: string; prefer: "direct" | "proxy" };

type PlayData = {
	code: number;
	msg?: string;
	title: string;
	pic?: string | null;
	desc?: string;
	year?: string | null;
	area?: string | null;
	actor?: string;
	source_id: string;
	source_name?: string;
	group: number;
	groups: Array<{ index: number; from: string; count: number }>;
	ep: number;
	episodes: Episode[];
};

type HistoryEntry = {
	key: string;
	title: string;
	poster?: string | null;
	source_id: string;
	vod_id: string;
	ep: number;
	time: number;
	duration: number;
	at: number;
};

const HISTORY_KEY = "aurora:history:v1";

function loadHistory(): HistoryEntry[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(HISTORY_KEY);
		return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
	} catch {
		return [];
	}
}

function saveHistory(list: HistoryEntry[]) {
	try {
		window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
	} catch {
		/* 隐私模式下可能写失败，忽略 */
	}
}

function fmtTime(s: number): string {
	if (!Number.isFinite(s) || s <= 0) return "00:00";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = Math.floor(s % 60);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(sec);
}

function Poster({ src, alt }: { src?: string | null; alt: string }) {
	const [bad, setBad] = useState(false);
	if (!src || bad) return <div className="poster-fallback">{alt.slice(0, 6)}</div>;
	// eslint-disable-next-line @next/next/no-img-element
	return (
		<img
			src={src}
			alt={alt}
			className="poster"
			loading="lazy"
			decoding="async"
			onError={() => setBad(true)}
		/>
	);
}

export default function HomePage() {
	const [kw, setKw] = useState("");
	const [searching, setSearching] = useState(false);
	const [results, setResults] = useState<Item[] | null>(null);
	const [searchMsg, setSearchMsg] = useState("");

	const [home, setHome] = useState<{ movies: Item[]; tv: Item[] } | null>(null);
	const [homeLoading, setHomeLoading] = useState(true);

	const [play, setPlay] = useState<PlayData | null>(null);
	const [playLoading, setPlayLoading] = useState(false);
	const [playMsg, setPlayMsg] = useState("");
	const [selected, setSelected] = useState<Item | null>(null);

	const [history, setHistory] = useState<HistoryEntry[]>([]);
	const [resumeAt, setResumeAt] = useState(0);

	const searchAbort = useRef<AbortController | null>(null);
	const playAbort = useRef<AbortController | null>(null);
	const playerBox = useRef<HTMLDivElement | null>(null);

	useEffect(() => setHistory(loadHistory()), []);

	useEffect(() => {
		let alive = true;
		fetch("/api/home")
			.then((r) => r.json())
			.then((d: { movies?: Item[]; tv?: Item[] }) => {
				if (alive) setHome({ movies: d.movies ?? [], tv: d.tv ?? [] });
			})
			.catch(() => undefined)
			.finally(() => alive && setHomeLoading(false));
		return () => {
			alive = false;
		};
	}, []);

	const doSearch = useCallback(
		async (keyword: string) => {
			const q = keyword.trim();
			if (!q) return;
			searchAbort.current?.abort();
			const ctrl = new AbortController();
			searchAbort.current = ctrl;
			setSearching(true);
			setSearchMsg("");
			try {
				const res = await fetch("/api/search?kw=" + encodeURIComponent(q), { signal: ctrl.signal });
				const data = (await res.json()) as { list?: Item[]; msg?: string };
				setResults(data.list ?? []);
				if (!data.list?.length) setSearchMsg(data.msg ?? "没有找到相关影片，换个关键词试试");
			} catch (e) {
				if ((e as Error).name !== "AbortError") setSearchMsg("搜索失败，请稍后重试");
			} finally {
				if (searchAbort.current === ctrl) setSearching(false);
			}
		},
		[],
	);

	const openPlay = useCallback(
		async (item: Item, ep = 0, group = -1, startAt = 0) => {
			playAbort.current?.abort();
			const ctrl = new AbortController();
			playAbort.current = ctrl;
			setSelected(item);
			setPlayLoading(true);
			setPlayMsg("");
			setResumeAt(startAt);
			try {
				const qs = new URLSearchParams({
					source: item.source_id,
					id: item.vod_id,
					ep: String(ep),
				});
				if (group >= 0) qs.set("group", String(group));
				const res = await fetch("/api/play?" + qs.toString(), { signal: ctrl.signal });
				const data = (await res.json()) as PlayData;
				if (data.code !== 200) {
					setPlay(null);
					setPlayMsg(data.msg ?? "获取播放地址失败");
				} else {
					setPlay(data);
					setTimeout(() => playerBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
				}
			} catch (e) {
				if ((e as Error).name !== "AbortError") setPlayMsg("网络错误，获取播放地址失败");
			} finally {
				if (playAbort.current === ctrl) setPlayLoading(false);
			}
		},
		[],
	);

	const current = play?.episodes?.[play.ep];

	const recordProgress = useCallback(
		(t: number, d: number) => {
			if (!play || !selected || !Number.isFinite(d) || d <= 0) return;
			if (Math.floor(t) % 5 !== 0) return; // 每 5s 记一次，避免频繁写 localStorage
			const key = play.source_id + ":" + selected.vod_id;
			const entry: HistoryEntry = {
				key,
				title: play.title,
				poster: selected.poster ?? null,
				source_id: play.source_id,
				vod_id: selected.vod_id,
				ep: play.ep,
				time: t,
				duration: d,
				at: Date.now(),
			};
			setHistory((prev) => {
				const next = [entry, ...prev.filter((h) => h.key !== key)];
				saveHistory(next);
				return next;
			});
		},
		[play, selected],
	);

	const gotoEp = useCallback(
		(delta: number) => {
			if (!play || !selected) return;
			const next = play.ep + delta;
			if (next < 0 || next >= play.episodes.length) return;
			setPlay({ ...play, ep: next });
			setResumeAt(0);
		},
		[play, selected],
	);

	const altSources = useMemo(() => {
		if (!selected) return [];
		return selected.alts ?? [];
	}, [selected]);

	const grid = (items: Item[]) => (
		<div className="grid">
			{items.map((it) => (
				<button
					type="button"
					key={it.source_id + ":" + it.vod_id}
					className="card"
					onClick={() => void openPlay(it)}
				>
					<div className="poster-box">
						<Poster src={it.poster} alt={it.title} />
						<span className="play-overlay">▶</span>
					</div>
					<div className="card-body">
						<div className="card-title">{it.title}</div>
						<div className="card-meta">
							{[it.year, it.remarks, it.source_name].filter(Boolean).join(" · ")}
							{it.alts && it.alts.length > 0 ? ` · ${it.alts.length + 1}个源` : ""}
						</div>
					</div>
				</button>
			))}
		</div>
	);

	return (
		<main className="page">
			<section className="hero">
				<h1 className="wordmark">AuroraTV</h1>
				<p className="card-meta">聚合搜索 · 多线路自动容错 · 浏览器直接看</p>
				<form
					className="search-bar"
					onSubmit={(e) => {
						e.preventDefault();
						void doSearch(kw);
					}}
				>
					<input
						className="search-input"
						value={kw}
						onChange={(e) => setKw(e.target.value)}
						placeholder="搜电影、电视剧、动漫…"
						aria-label="搜索"
					/>
					<button className="search-btn" type="submit" disabled={searching}>
						{searching ? "搜索中…" : "搜索"}
					</button>
				</form>
			</section>

			{/* -------------------- 播放区 -------------------- */}
			{(play || playLoading || playMsg) && (
				<section ref={playerBox} className="section">
					<div className="section-head">
						<h2>{play?.title ?? selected?.title ?? "正在加载"}</h2>
						<button type="button" className="pill" onClick={() => { setPlay(null); setPlayMsg(""); }}>
							关闭
						</button>
					</div>

					{playLoading && <div className="skeleton" style={{ height: 320 }} />}
					{!playLoading && playMsg && <div className="empty">{playMsg}</div>}

					{!playLoading && play && current && (
						<>
							<Player
								key={play.source_id + ":" + play.ep + ":" + current.url}
								url={current.url}
								proxyUrl={current.proxy}
								prefer={current.prefer}
								poster={play.pic ?? undefined}
								title={play.title + " " + (current.name ?? "")}
								sourceId={play.source_id}
								startTime={resumeAt}
								onProgress={recordProgress}
								onEnded={() => gotoEp(1)}
								onNext={play.ep + 1 < play.episodes.length ? () => gotoEp(1) : undefined}
								onPrev={play.ep > 0 ? () => gotoEp(-1) : undefined}
							/>

							{play.groups.length > 1 && (
								<div className="chips">
									<span className="card-meta">线路：</span>
									{play.groups.map((g) => (
										<button
											type="button"
											key={g.index}
											className={"chip " + (g.index === play.group ? "chip-on" : "")}
											onClick={() => selected && void openPlay(selected, 0, g.index)}
										>
											{g.from}（{g.count}）
										</button>
									))}
								</div>
							)}

							{altSources.length > 0 && (
								<div className="chips">
									<span className="card-meta">换源：</span>
									<button
										type="button"
										className={"chip " + (play.source_id === selected?.source_id ? "chip-on" : "")}
										onClick={() => selected && void openPlay(selected, play.ep)}
									>
										{selected?.source_name ?? "主源"}
									</button>
									{altSources.map((a) => (
										<button
											type="button"
											key={a.source_id + ":" + a.vod_id}
											className={"chip " + (play.source_id === a.source_id ? "chip-on" : "")}
											onClick={() =>
												void openPlay(
													{
														...(selected as Item),
														source_id: a.source_id,
														source_name: a.source_name,
														vod_id: a.vod_id,
													},
													play.ep,
												)
											}
										>
											{a.source_name ?? a.source_id}
										</button>
									))}
								</div>
							)}

							{play.episodes.length > 1 && (
								<div className="chips ep-list">
									{play.episodes.map((e, i) => (
										<button
											type="button"
											key={i}
											className={"chip " + (i === play.ep ? "chip-on" : "")}
											onClick={() => {
												setResumeAt(0);
												setPlay({ ...play, ep: i });
											}}
										>
											{e.name}
										</button>
									))}
								</div>
							)}

							{play.desc && <p className="card-meta desc">{play.desc}</p>}
						</>
					)}
				</section>
			)}

			{/* -------------------- 继续观看 -------------------- */}
			{history.length > 0 && !play && (
				<section className="section">
					<div className="section-head">
						<h2>继续观看</h2>
						<button
							type="button"
							className="pill"
							onClick={() => {
								setHistory([]);
								saveHistory([]);
							}}
						>
							清空
						</button>
					</div>
					<div className="chips">
						{history.slice(0, 12).map((h) => (
							<button
								type="button"
								key={h.key}
								className="chip"
								onClick={() =>
									void openPlay(
										{
											source_id: h.source_id,
											vod_id: h.vod_id,
											title: h.title,
											poster: h.poster,
										},
										h.ep,
										-1,
										h.time,
									)
								}
							>
								{h.title} · {fmtTime(h.time)}
							</button>
						))}
					</div>
				</section>
			)}

			{/* -------------------- 搜索结果 -------------------- */}
			{results && (
				<section className="section">
					<div className="section-head">
						<h2>搜索结果（{results.length}）</h2>
						<button type="button" className="pill" onClick={() => setResults(null)}>
							返回首页
						</button>
					</div>
					{results.length === 0 ? <div className="empty">{searchMsg}</div> : grid(results)}
				</section>
			)}

			{/* -------------------- 首页推荐 -------------------- */}
			{!results && (
				<>
					<section className="section">
						<div className="section-head">
							<h2>近期电影</h2>
						</div>
						{homeLoading ? (
							<div className="grid">
								{Array.from({ length: 6 }).map((_, i) => (
									<div className="skeleton" key={i} style={{ height: 240 }} />
								))}
							</div>
						) : home?.movies.length ? (
							grid(home.movies)
						) : (
							<div className="empty">暂无数据，请先在后台导入片源并等待一次定时体检</div>
						)}
					</section>
					<section className="section">
						<div className="section-head">
							<h2>近期剧集</h2>
						</div>
						{homeLoading ? (
							<div className="grid">
								{Array.from({ length: 6 }).map((_, i) => (
									<div className="skeleton" key={i} style={{ height: 240 }} />
								))}
							</div>
						) : home?.tv.length ? (
							grid(home.tv)
						) : (
							<div className="empty">暂无数据</div>
						)}
					</section>
				</>
			)}
		</main>
	);
}
