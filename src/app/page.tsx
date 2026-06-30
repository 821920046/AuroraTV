"use client";
import { useEffect, useState } from "react";
import Player from "@/components/Player";

type Item = {
	source_id: string;
	vod_id: string;
	title: string;
	poster?: string;
	year?: number;
	remarks?: string;
};

export default function Home() {
	const [kw, setKw] = useState("");
	const [list, setList] = useState<Item[]>([]);
	const [loading, setLoading] = useState(false);
	const [searched, setSearched] = useState(false);
	const [playUrl, setPlayUrl] = useState<string | null>(null);
	const [playSource, setPlaySource] = useState<string | undefined>();
	const [playMsg, setPlayMsg] = useState("");
	const [playLoading, setPlayLoading] = useState(false);
	const [movies, setMovies] = useState<Item[]>([]);
	const [tv, setTv] = useState<Item[]>([]);
	const [homeLoading, setHomeLoading] = useState(true);
	const [webOnly, setWebOnly] = useState(true);

	useEffect(() => {
		(async () => {
			try {
				const r = await fetch("/api/home");
				const data = (await r.json()) as { movies?: Item[]; tv?: Item[] };
				setMovies(data.movies ?? []);
				setTv(data.tv ?? []);
			} catch {
				setMovies([]);
				setTv([]);
			} finally {
				setHomeLoading(false);
			}
		})();
	}, []);

	// 切换「只看网页可播」时，若已搜索过则用新条件重搜。
	useEffect(() => {
		if (searched && kw.trim()) search();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [webOnly]);

	async function search(term?: string) {
		const q = (term ?? kw).trim();
		if (!q) return;
		if (term) setKw(term);
		setLoading(true);
		setSearched(true);
		try {
			const r = await fetch(
				"/api/search?wd=" + encodeURIComponent(q) + (webOnly ? "" : "&webOnly=0"),
			);
			const data = (await r.json()) as { list?: Item[] };
			setList(data.list ?? []);
		} catch {
			setList([]);
		} finally {
			setLoading(false);
		}
	}

	async function play(it: Item) {
		setPlayLoading(true);
		setPlayMsg("正在解析播放地址…");
		setPlayUrl(null);
		try {
			const r = await fetch(
				"/api/play?source=" + encodeURIComponent(it.source_id) + "&id=" + encodeURIComponent(it.vod_id),
			);
			const text = await r.text();
			let data: { url?: string; msg?: string } = {};
			try {
				data = text ? (JSON.parse(text) as { url?: string; msg?: string }) : {};
			} catch {
				data = { msg: "播放接口返回异常，请重新部署最新版本" };
			}
			if (!r.ok || !data.url) {
				setPlayMsg(data.msg ? "无法播放：" + data.msg : "无法播放：没有可用播放地址");
				return;
			}
			setPlayUrl(data.url);
			setPlaySource(it.source_id);
			setPlayMsg("");
		} catch {
			setPlayMsg("无法播放：网络请求失败");
		} finally {
			setPlayLoading(false);
		}
	}

	const renderCard = (it: Item) => (
		<div key={it.source_id + ":" + it.vod_id} className="card" onClick={() => play(it)}>
			<div className="poster-box">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				{it.poster ? (
					<img className="poster" src={it.poster} alt={it.title} />
				) : (
					<div className="poster-fallback">{it.title.slice(0, 1)}</div>
				)}
				<div className="play-overlay">▶</div>
			</div>
			<div className="card-body">
				<div className="card-title">{it.title}</div>
				<div className="card-meta">{(it.year ?? "") + " " + (it.remarks ?? "")}</div>
			</div>
		</div>
	);

	return (
		<>
			<header className="site-header">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img className="logo-badge" src="/logo.png" alt="AuroraTV" />
				<span className="wordmark">AuroraTV</span>
				<div className="header-spacer" />
				<a className="header-link" href="/admin">片源管理</a>
			</header>

			<main className="container">
				<section className="hero">
					<h1>
						探索星辰下的<span className="grad">每一帧光影</span>
					</h1>
					<p>聚合多源搜索 · 智能择优播放 · 极速流畅体验</p>
					<div className="search-bar">
						<input
							className="search-input"
							value={kw}
							onChange={(e) => setKw(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && search()}
							placeholder="搜索电影、剧集、动漫…"
						/>
						<button className="search-btn" onClick={() => search()} disabled={loading}>
							{loading ? "搜索中…" : "搜索"}
						</button>
					</div>
				</section>

				{(playLoading || playMsg) && !playUrl && (
					<div className="empty">
						<div className="emoji">{playLoading ? "⏳" : "⚠️"}</div>
						<h3>{playLoading ? "正在准备播放" : "播放失败"}</h3>
						<p>{playMsg}</p>
					</div>
				)}

				{playUrl && (
					<div className="player-wrap">
						<Player url={playUrl} sourceId={playSource} onAllFailed={() => setPlayUrl(null)} />
					</div>
				)}

				{loading && (
					<div className="grid">
						{Array.from({ length: 12 }).map((_, i) => (
							<div className="skeleton" key={i}>
								<div className="sk-poster" />
								<div className="sk-line" />
								<div className="sk-line short" />
							</div>
						))}
					</div>
				)}

				{!loading && list.length > 0 && (
					<>
						<div className="section-head">
							<h2>搜索结果</h2>
							<label className="web-only-toggle">
								<input
									type="checkbox"
									checked={webOnly}
									onChange={(e) => setWebOnly(e.target.checked)}
								/>{" "}
								只看网页可播 🌐
							</label>
							<span>共 {list.length} 条</span>
						</div>
						<div className="grid">
							{list.map((it) => (
								<div
									key={it.source_id + ":" + it.vod_id}
									className="card"
									onClick={() => play(it)}
								>
									<div className="poster-box">
										{/* eslint-disable-next-line @next/next/no-img-element */}
										{it.poster ? (
											<img className="poster" src={it.poster} alt={it.title} />
										) : (
											<div className="poster-fallback">{it.title.slice(0, 1)}</div>
										)}
										<div className="play-overlay">▶</div>
									</div>
									<div className="card-body">
										<div className="card-title">{it.title}</div>
										<div className="card-meta">
											{it.year ?? ""} {it.remarks ?? ""}
										</div>
									</div>
								</div>
							))}
						</div>
					</>
				)}

				{!loading && searched && list.length === 0 && (
					<div className="empty">
						<div className="emoji">🔍</div>
						<h3>没有找到相关内容</h3>
						<p>换个关键词试试。如果一直没有结果，可能是后台还没有配置可用片源（src/lib/sources.ts）。</p>
					</div>
				)}

				{!loading && !searched && (
					<>
						{homeLoading && (
							<div className="grid">
								{Array.from({ length: 12 }).map((_, i) => (
									<div className="skeleton" key={i}>
										<div className="sk-poster" />
										<div className="sk-line" />
										<div className="sk-line short" />
									</div>
								))}
							</div>
						)}
						{!homeLoading && movies.length > 0 && (
							<>
								<div className="section-head">
									<h2>热门电影</h2>
									<span>近期热播</span>
								</div>
								<div className="grid">{movies.map(renderCard)}</div>
							</>
						)}
						{!homeLoading && tv.length > 0 && (
							<>
								<div className="section-head">
									<h2>热门电视剧</h2>
									<span>近期热播</span>
								</div>
								<div className="grid">{tv.map(renderCard)}</div>
							</>
						)}
						{!homeLoading && movies.length === 0 && tv.length === 0 && (
							<div className="empty">
								<div className="emoji">🌌</div>
								<h3>开始你的观影之旅</h3>
								<p>在上方输入片名搜索。若此处长期为空，可能是后台片源暂时无法返回最新列表，可到「片源管理」点「立即体检」。</p>
							</div>
						)}
					</>
				)}

				<footer className="site-footer">
					AuroraTV · 基于 OpenNext 部署于 Cloudflare Workers
					<br />
					本站仅作技术学习与个人使用，所有内容版权归原作者所有
				</footer>
			</main>
		</>
	);
}
