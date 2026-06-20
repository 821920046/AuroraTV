"use client";
import { useState } from "react";
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
	const [playUrl, setPlayUrl] = useState<string | null>(null);
	const [playSource, setPlaySource] = useState<string | undefined>();

	async function search() {
		if (!kw.trim()) return;
		setLoading(true);
		try {
			const r = await fetch("/api/search?wd=" + encodeURIComponent(kw));
			const data = (await r.json()) as { list?: Item[] };
			setList(data.list ?? []);
		} finally {
			setLoading(false);
		}
	}

	async function play(it: Item) {
		const r = await fetch("/api/play?source=" + it.source_id + "&id=" + it.vod_id);
		const data = (await r.json()) as { url?: string };
		if (data.url) {
			setPlayUrl(data.url);
			setPlaySource(it.source_id);
		}
	}

	return (
		<main className="container">
			<h1 className="brand">🌌 AuroraTV</h1>
			<div className="search-bar">
				<input
					className="search-input"
					value={kw}
					onChange={(e) => setKw(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && search()}
					placeholder="搜索影视…"
				/>
				<button onClick={search} disabled={loading}>
					{loading ? "搜索中…" : "搜索"}
				</button>
			</div>

			{playUrl && (
				<div className="player-wrap">
					<Player url={playUrl} sourceId={playSource} onAllFailed={() => setPlayUrl(null)} />
				</div>
			)}

			<div className="grid">
				{list.map((it) => (
					<div
						key={it.source_id + ":" + it.vod_id}
						className="card"
						onClick={() => play(it)}
					>
						{/* eslint-disable-next-line @next/next/no-img-element */}
						{it.poster && <img className="poster" src={it.poster} alt={it.title} />}
						<div className="card-title">{it.title}</div>
						<div className="card-meta">
							{it.year ?? ""} {it.remarks ?? ""}
						</div>
					</div>
				))}
			</div>
		</main>
	);
}
