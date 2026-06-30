"use client";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Props = {
	url: string;
	sourceId?: string;
	onAllFailed?: () => void;
};

// 播放器：HLS(hls.js) -> 原生 HLS / 直链(video) -> 失败提示。
// 直播流地址几乎都禁止被 iframe 内嵌，故不再用 iframe 兜底，改为清晰的失败面板。
export default function Player({ url, sourceId, onAllFailed }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [failed, setFailed] = useState(false);
	const [copied, setCopied] = useState(false);

	// 混合内容：https 站点无法加载 http 流，浏览器会直接拦截
	const mixedContent =
		typeof window !== "undefined" &&
		window.location.protocol === "https:" &&
		url.startsWith("http://");

	useEffect(() => {
		setFailed(false);
		setCopied(false);
		if (mixedContent) {
			setFailed(true);
			return;
		}
		const video = videoRef.current;
		if (!video) return;

		// 直播首帧可能较慢，给 8 秒再判失败
		const failTimer = setTimeout(() => {
			reportFailure(sourceId);
			setFailed(true);
		}, 8000);
		const onPlaying = () => clearTimeout(failTimer);
		const onError = () => {
			clearTimeout(failTimer);
			reportFailure(sourceId);
			setFailed(true);
		};
		video.addEventListener("playing", onPlaying);
		video.addEventListener("error", onError);

		let hls: Hls | null = null;
		const isM3u8 = url.includes(".m3u8");

		if (isM3u8 && Hls.isSupported()) {
			hls = new Hls({ enableWorker: true });
			hls.loadSource(url);
			hls.attachMedia(video);
			hls.on(Hls.Events.ERROR, (_e, data) => {
				if (data.fatal) onError();
			});
		} else if (video.canPlayType("application/vnd.apple.mpegurl") || !isM3u8) {
			video.src = url;
			video.play().catch(() => {});
		} else {
			onError();
		}

		return () => {
			clearTimeout(failTimer);
			video.removeEventListener("playing", onPlaying);
			video.removeEventListener("error", onError);
			hls?.destroy();
		};
	}, [url, sourceId, mixedContent]);

	function copy() {
		navigator.clipboard?.writeText(url).then(
			() => setCopied(true),
			() => {},
		);
	}

	if (failed) {
		return (
			<div className="player-fail">
				<div className="emoji">📡</div>
				<h3>无法播放这个频道</h3>
				<p className="player-fail-msg">
					{mixedContent
						? "该源是 http 地址，https 站点会被浏览器拦截（混合内容）。"
						: "源不可达或受地区限制（常见为 523 / 拒绝连接 / 仅限境内网络）。"}
				</p>
				<p className="player-fail-url">{url}</p>
				<div className="player-fail-actions">
					<button className="pill on" onClick={copy}>
						{copied ? "已复制" : "复制地址"}
					</button>{" "}
					<button className="pill danger" onClick={onAllFailed}>
						关闭并重选
					</button>
				</div>
				<p className="player-fail-hint">
					可把地址粘到 VLC / PotPlayer 等播放器打开；受地区限制的源需在对应地区网络下才能播。
				</p>
			</div>
		);
	}

	return <video ref={videoRef} className="player-frame" controls autoPlay playsInline />;
}

function reportFailure(sourceId?: string) {
	if (!sourceId) return;
	fetch("/api/sources", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source_id: sourceId }),
	}).catch(() => {});
}
