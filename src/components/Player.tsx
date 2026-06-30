"use client";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Props = {
	url: string;
	sourceId?: string;
	onAllFailed?: () => void;
};

// 仅对“域名 + 标准端口”的 http 源尝试升级 https；裸 IP 或带端口的源升级几乎必然 SSL 报错，直接跳过。
function canUpgradeHttps(u: string): boolean {
	try {
		const h = new URL(u);
		if (h.protocol !== "http:") return false;
		const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h.hostname);
		if (isIp) return false;
		if (h.port && h.port !== "80") return false;
		return true;
	} catch {
		return false;
	}
}

// 播放器：HLS(hls.js) -> 原生 HLS / 直链(video) -> 失败提示。
export default function Player({ url, sourceId, onAllFailed }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [failed, setFailed] = useState(false);
	const [copied, setCopied] = useState(false);

	const isHttps =
		typeof window !== "undefined" && window.location.protocol === "https:";
	const wasHttp = url.startsWith("http://");
	const canUp = canUpgradeHttps(url);
	const playUrl = isHttps && wasHttp && canUp ? url.replace(/^http:\/\//, "https://") : url;
	// 裸 IP / 带端口的 http 源在 https 页面里必被拦截且无法升级 → 直接判失败，省去 8 秒等待
	const willBlock = isHttps && wasHttp && !canUp;

	useEffect(() => {
		setFailed(false);
		setCopied(false);
		if (willBlock) {
			setFailed(true);
			return;
		}
		const video = videoRef.current;
		if (!video) return;

		// 首帧可能较慢，给 8 秒再判失败
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
		const isM3u8 = playUrl.includes(".m3u8");

		if (isM3u8 && Hls.isSupported()) {
			hls = new Hls({ enableWorker: true });
			hls.loadSource(playUrl);
			hls.attachMedia(video);
			hls.on(Hls.Events.ERROR, (_e, data) => {
				if (data.fatal) onError();
			});
		} else if (video.canPlayType("application/vnd.apple.mpegurl") || !isM3u8) {
			video.src = playUrl;
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
	}, [playUrl, sourceId, willBlock]);

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
				<h3>无法播放这个资源</h3>
				<p className="player-fail-msg">
					{wasHttp && isHttps
						? "该源是 http 地址，https 站点会被浏览器拦截（混合内容）；这类源请复制地址到 VLC/PotPlayer 播放。"
						: "源不可达 / 跨域(CORS)被拦 / 受地区限制（常见为 403、523、拒绝连接、仅限境内网络）。"}
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
