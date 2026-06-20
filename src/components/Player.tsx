"use client";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Props = {
	url: string;
	sourceId?: string;
	onAllFailed?: () => void;
};

// 播放 Fallback: HLS(hls.js) -> 原生/MP4 直链 -> iframe 嵌入；3 秒超时则上报并切换
export default function Player({ url, sourceId, onAllFailed }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [mode, setMode] = useState<"video" | "iframe">("video");

	useEffect(() => {
		if (mode !== "video") return;
		const video = videoRef.current;
		if (!video) return;

		const failTimer = setTimeout(() => {
			reportFailure(sourceId);
			setMode("iframe");
		}, 3000);

		const onPlaying = () => clearTimeout(failTimer);
		video.addEventListener("playing", onPlaying);

		let hls: Hls | null = null;
		const isM3u8 = url.includes(".m3u8");

		if (isM3u8 && Hls.isSupported()) {
			hls = new Hls({ enableWorker: true });
			hls.loadSource(url);
			hls.attachMedia(video);
			hls.on(Hls.Events.ERROR, (_e, data) => {
				if (data.fatal) {
					clearTimeout(failTimer);
					reportFailure(sourceId);
					setMode("iframe");
				}
			});
		} else if (video.canPlayType("application/vnd.apple.mpegurl") || !isM3u8) {
			video.src = url;
			video.play().catch(() => {});
		} else {
			clearTimeout(failTimer);
			setMode("iframe");
		}

		return () => {
			clearTimeout(failTimer);
			video.removeEventListener("playing", onPlaying);
			hls?.destroy();
		};
	}, [url, mode, sourceId]);

	if (mode === "iframe") {
		// 最后兜底：第三方嵌入播放器（仅在你信任该来源时使用）
		return (
			<div>
				<iframe className="player-frame" src={url} allowFullScreen />
				<button onClick={onAllFailed}>仍无法播放？关闭并重选</button>
			</div>
		);
	}

	return <video ref={videoRef} className="player-frame" controls />;
}

function reportFailure(sourceId?: string) {
	if (!sourceId) return;
	fetch("/api/sources", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source_id: sourceId }),
	}).catch(() => {});
}
