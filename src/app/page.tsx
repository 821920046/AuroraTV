"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Player from "@/components/Player";
import SiteHeader from "@/components/SiteHeader";

// ============================================================================
// 首页：搜索 -> 选片 -> 选集 -> 播放
// ----------------------------------------------------------------------------
// 布局上的三处关键取舍：
//  1) 加 SiteHeader —— 旧版首页完全没有导航，进不了直播页和管理页。
//  2) hero 可收缩 —— 用户一旦搜索过，搜索框不再是主角，hero 收成一行，
//     否则 40px 大标题 + 56px 上边距会把结果挤到折叠线以下，必须滚动才看得到。
//  3) 「继续观看」用带进度条的海报卡片，而不是旧版那一排纯文字胶囊 ——
//     认片靠的是海报，不是片名文字。
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

/**
 * 剧集条目【只有名字】。
 * 地址只对「当前这一集」在顶层给一份（url / proxy / prefer）——
 * 100 集的剧不再一次回传 200 个 URL，切集时带 ep 重新请求，命中服务端详情缓存。
 */
type Episode = { name: string };

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
	/** 当前集的上游原地址 */
	url: string;
	/** 当前集的同源签名代理地址 */
	proxy: string;
	/** 服务端建议的首选线路 */
	prefer: "direct" | "proxy";
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
	// 项目在 Workers 上关闭了 Next 图片优化（images.unoptimized），且海报一律走
	// /api/img 代理，因此这里刻意使用原生 <img>。注释必须紧贴 <img> 才生效。
	return (
		// eslint-disable-next-line @next/next/no-img-element
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
	/**
	 * 正在加载的集号。
	 * 切集要走一次网络，而 play.ep 要等数据回来才变 —— 没有它，选集网格上的
	 * 高亮会「滞后一拍」，用户点了第 5 集却看到第 3 集还亮着。
	 */
	const [pendingEp, setPendingEp] = useState<number | null>(null);

	const [history, setHistory] = useState<HistoryEntry[]>([]);
	const [resumeAt, setResumeAt] = useState(0);

	const searchAbort = useRef<AbortController | null>(null);
	const playAbort = useRef<AbortController | null>(null);
	const playerBox = useRef<HTMLDivElement | null>(null);
	const epBox = useRef<HTMLDivElement | null>(null);
	/** 读「是否已经打开过片子」，避免把 play 塞进 openPlay 的依赖里 */
	const playRef = useRef<PlayData | null>(null);
	/**
	 * 本次「同一部片」已经尝试过的片源。
	 * 自动换源必须有这个防死循环：A 源失败换 B 源、B 源失败又换回 A 源 ——
	 * 用户看到的是播放器无限重试，比直接报错还糟。
	 */
	const triedRef = useRef<{ vodId: string; ids: Set<string> }>({ vodId: "", ids: new Set() });

	useEffect(() => setHistory(loadHistory()), []);

	useEffect(() => {
		let alive = true;
		fetch("/api/home")
			.then((r) => r.json())
			// 注意：@cloudflare/workers-types 把全局 Response.json() 标为 Promise<unknown>，
			// 因此这里必须显式断言，不能靠参数注解（注解会与 unknown 冲突）。
			.then((raw) => {
				const d = raw as { movies?: Item[]; tv?: Item[] };
				if (alive) setHome({ movies: d.movies ?? [], tv: d.tv ?? [] });
			})
			.catch(() => undefined)
			.finally(() => alive && setHomeLoading(false));
		return () => {
			alive = false;
		};
	}, []);

	const doSearch = useCallback(async (keyword: string) => {
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
	}, []);

	const openPlay = useCallback(async (item: Item, ep = 0, group = -1, startAt = 0) => {
		playAbort.current?.abort();
		const ctrl = new AbortController();
		playAbort.current = ctrl;
		setSelected(item);
		setPlayMsg("");
		setResumeAt(startAt);
		// 记录本次使用的片源，供自动换源判断「还有没有没试过的」。
		// 换了一部片（vod_id 变了）就重置，否则会误以为新片的源都试过了。
		if (triedRef.current.vodId !== item.vod_id) {
			triedRef.current = { vodId: item.vod_id, ids: new Set() };
		}
		triedRef.current.ids.add(item.source_id);
		// 首次打开才显示骨架屏。切集/换源时保留当前播放器直到新地址到达 ——
		// 否则每换一集画面都会闪一下骨架，观感上比多等 200ms 差得多。
		if (playRef.current) setPendingEp(ep);
		else setPlayLoading(true);
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
			if (playAbort.current === ctrl) {
				setPlayLoading(false);
				setPendingEp(null);
			}
		}
	}, []);

	useEffect(() => {
		playRef.current = play;
	}, [play]);

	/** 地址来自顶层（只有当前集有），集名从 episodes 取 */
	const epName = play?.episodes[play.ep]?.name ?? "";
	/** 选集网格的高亮位置：优先显示「正在加载的那一集」 */
	const activeEp = pendingEp ?? play?.ep ?? 0;

	// 换集后把当前集滚进视野。
	// 只在「确实不在可视区内」时才滚，否则每次换集都会把页面顶一下。
	useEffect(() => {
		const box = epBox.current;
		if (!box || !play) return;
		const el = box.querySelector<HTMLElement>('[data-current="1"]');
		if (!el) return;
		const r = el.getBoundingClientRect();
		const c = box.getBoundingClientRect();
		if (r.top < c.top || r.bottom > c.bottom) el.scrollIntoView({ block: "nearest" });
	}, [play]);

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
			// 不能再用 setPlay({...play, ep: next}) 本地改状态了：
			// 地址现在只对「当前集」下发，换集必须真的去服务端取一次新地址。
			void openPlay(selected, next, play.group, 0);
		},
		[play, selected, openPlay],
	);

	const altSources = useMemo(() => {
		if (!selected) return [];
		return selected.alts ?? [];
	}, [selected]);

	const closePlay = useCallback(() => {
		setPlay(null);
		setPlayMsg("");
	}, []);

	const backHome = useCallback(() => {
		setResults(null);
		setSearchMsg("");
		window.scrollTo({ top: 0, behavior: "smooth" });
	}, []);

	const grid = (items: Item[]) => (
		<div className="grid">
			{items.map((it) => {
				const altCount = it.alts?.length ?? 0;
				return (
					<button
						type="button"
						key={it.source_id + ":" + it.vod_id}
						className="card"
						onClick={() => void openPlay(it)}
						aria-label={`播放 ${it.title}`}
					>
						<div className="poster-box">
							<Poster src={it.poster} alt={it.title} />
							{it.remarks ? <span className="card-badge">{it.remarks}</span> : null}
							{altCount > 0 ? (
								<span className="card-badge is-alt">{altCount + 1} 源</span>
							) : null}
							<span className="play-overlay" aria-hidden="true" />
						</div>
						<div className="card-body">
							<div className="card-title">{it.title}</div>
							<div className="card-meta">
								{[it.year, it.type_name, it.source_name].filter(Boolean).join(" · ")}
							</div>
						</div>
					</button>
				);
			})}
		</div>
	);

	const skeletonGrid = (n: number) => (
		<div className="grid" aria-hidden="true">
			{Array.from({ length: n }).map((_, i) => (
				<div className="skeleton" key={i}>
					<div className="sk-poster" />
					<div className="sk-line" />
					<div className="sk-line short" />
				</div>
			))}
		</div>
	);

	return (
		<>
			<SiteHeader />

			<main className="page">
				{/* 已进入搜索态就把 hero 收起来，让结果尽量靠上 */}
				<section className={"hero" + (results ? " is-compact" : "")}>
					<h1 className="hero-title">
						Aurora<span className="grad">TV</span>
					</h1>
					<p className="hero-sub">聚合搜索 · 多线路自动容错 · 浏览器直接看</p>
					<form
						className="search-bar"
						onSubmit={(e) => {
							e.preventDefault();
							void doSearch(kw);
						}}
						role="search"
					>
						<input
							className="search-input"
							value={kw}
							onChange={(e) => setKw(e.target.value)}
							placeholder="搜电影、电视剧、动漫…"
							aria-label="搜索影片"
							enterKeyHint="search"
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
							<button type="button" className="pill" onClick={closePlay}>
								关闭
							</button>
						</div>

						{playLoading && (
							<div className="player-wrap">
								<div className="skeleton" style={{ aspectRatio: "16 / 9" }} />
							</div>
						)}

						{!playLoading && playMsg && (
							<div className="empty">
								<div className="emoji">😕</div>
								<h3>打不开这个片子</h3>
								<p>{playMsg}</p>
							</div>
						)}

						{!playLoading && play && (
							<>
								<Player
									key={play.source_id + ":" + play.ep + ":" + play.url}
									url={play.url}
									proxyUrl={play.proxy}
									prefer={play.prefer}
									poster={play.pic ?? undefined}
									title={play.title + " " + epName}
									sourceId={play.source_id}
									startTime={resumeAt}
									onProgress={recordProgress}
									onEnded={() => gotoEp(1)}
									onNext={play.ep + 1 < play.episodes.length ? () => gotoEp(1) : undefined}
									onPrev={play.ep > 0 ? () => gotoEp(-1) : undefined}
									onExhausted={(at) => {
										// 代理线路和直连线路都挂了 —— 换一个片源重试。
										// 片源质量参差是这类项目的常态，这一步能救回相当一部分
										// 「点开播不了」，比让用户自己去点「换源」有用得多。
										if (!play || !selected) return false;
										const next = (selected.alts ?? []).find(
											(a) => !triedRef.current.ids.has(a.source_id),
										);
										if (!next) return false;
										void openPlay(
											{
												...selected,
												source_id: next.source_id,
												source_name: next.source_name,
												vod_id: next.vod_id,
											},
											play.ep,
											-1,
											// 播了不到 5 秒就失败，说明还没真正看到内容，从头开始更合理
											at > 5 ? at : 0,
										);
										return true;
									}}
								/>

								{/* 片子信息：旧版从接口取回了 year / area / actor / desc 却只渲染了 desc，
								    而且用的是 12px 的 .card-meta —— 等于把这些数据白拿了。 */}
								<div className="detail-head">
									{play.pic ? (
										<div className="detail-poster">
											<Poster src={play.pic} alt={play.title} />
										</div>
									) : null}
									<div className="detail-info">
										<h3 className="detail-title">{play.title}</h3>
										<div className="detail-tags">
											{play.year ? <span className="tag">{play.year}</span> : null}
											{play.area ? <span className="tag">{play.area}</span> : null}
											<span className="tag">{play.source_name ?? play.source_id}</span>
											<span className="tag">
												第 {activeEp + 1} / {play.episodes.length} 集
											</span>
										</div>
										{play.actor ? (
											<p className="card-meta">主演：{play.actor}</p>
										) : null}
									</div>
								</div>

								{play.groups.length > 1 && (
									<div className="chips">
										<span className="chips-label">线路</span>
										{play.groups.map((g) => (
											<button
												type="button"
												key={g.index}
												className={"chip " + (g.index === play.group ? "chip-on" : "")}
												aria-pressed={g.index === play.group}
												onClick={() => selected && void openPlay(selected, 0, g.index)}
											>
												{g.from}（{g.count}）
											</button>
										))}
									</div>
								)}

								{altSources.length > 0 && (
									<div className="chips">
										<span className="chips-label">换源</span>
										<button
											type="button"
											className={"chip " + (play.source_id === selected?.source_id ? "chip-on" : "")}
											aria-pressed={play.source_id === selected?.source_id}
											onClick={() => selected && void openPlay(selected, play.ep)}
										>
											{selected?.source_name ?? "主源"}
										</button>
										{altSources.map((a) => (
											<button
												type="button"
												key={a.source_id + ":" + a.vod_id}
												className={"chip " + (play.source_id === a.source_id ? "chip-on" : "")}
												aria-pressed={play.source_id === a.source_id}
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
									<div className="ep-grid" ref={epBox} aria-label="剧集列表">
										{play.episodes.map((e, i) => (
											<button
												type="button"
												key={i}
												data-current={i === activeEp ? "1" : undefined}
												className={"ep-btn" + (i === activeEp ? " is-current" : "")}
												aria-current={i === activeEp ? "true" : undefined}
												title={e.name}
												onClick={() => {
													if (!selected || i === play.ep) return;
													void openPlay(selected, i, play.group, 0);
												}}
											>
												{e.name}
											</button>
										))}
									</div>
								)}

								{play.desc ? <p className="desc">{play.desc}</p> : null}
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
						<div className="history-grid">
							{history.slice(0, 8).map((h) => {
								const pct =
									h.duration > 0 ? Math.min(100, Math.max(1, (h.time / h.duration) * 100)) : 0;
								return (
									<button
										type="button"
										key={h.key}
										className="history-card"
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
										<div className="history-thumb">
											<Poster src={h.poster} alt={h.title} />
										</div>
										<div className="history-info">
											<div className="history-title">{h.title}</div>
											<div className="history-meta">
												第 {h.ep + 1} 集 · 看到 {fmtTime(h.time)}
											</div>
											{pct > 0 ? (
												<div className="history-progress" aria-hidden="true">
													<i style={{ width: pct + "%" }} />
												</div>
											) : null}
										</div>
									</button>
								);
							})}
						</div>
					</section>
				)}

				{/* -------------------- 搜索结果 -------------------- */}
				{results && (
					<section className="section">
						<div className="section-head">
							<h2>搜索结果（{results.length}）</h2>
							<button type="button" className="pill" onClick={backHome}>
								返回首页
							</button>
						</div>
						<div aria-live="polite">
							{results.length === 0 ? (
								<div className="empty">
									<div className="emoji">🔍</div>
									<h3>没有找到结果</h3>
									<p>{searchMsg}</p>
								</div>
							) : (
								grid(results)
							)}
						</div>
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
								skeletonGrid(6)
							) : home?.movies.length ? (
								grid(home.movies)
							) : (
								<div className="empty">
									<div className="emoji">🎬</div>
									<h3>还没有内容</h3>
									<p>请先在「管理」页导入片源，并等待一次定时体检。</p>
								</div>
							)}
						</section>
						<section className="section">
							<div className="section-head">
								<h2>近期剧集</h2>
							</div>
							{homeLoading ? (
								skeletonGrid(6)
							) : home?.tv.length ? (
								grid(home.tv)
							) : (
								<div className="empty">
									<div className="emoji">📺</div>
									<h3>还没有剧集</h3>
									<p>剧集数据来自已启用片源的最近更新。</p>
								</div>
							)}
						</section>
					</>
				)}

				<footer className="site-footer">
					AuroraTV · 内容来自第三方采集接口，本站不存储任何视频文件
					<br />
					仅供个人学习与测试，请支持正版
				</footer>
			</main>
		</>
	);
}
