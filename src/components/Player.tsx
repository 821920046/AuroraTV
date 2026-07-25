"use client";

import Hls, { type ErrorData, type Events, type Level } from "hls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ============================================================================
// 播放器（完整重写）
// ----------------------------------------------------------------------------
// 旧版病因：
//  1) 发现 http 地址就直接弹失败页（willBlock），从不尝试任何补救；
//  2) 只有一个候选地址，失败即终止；
//  3) 盲目的 8s 定时器，只要没触发 playing 就判死，慢源、缓冲中的流都会被误杀；
//  4) hls.js 报错后没有任何 recover，而官方 API 本来就提供了可恢复路径。
// 新版：双候选地址（代理/直连）→ 错误分类恢复 → 自动降级到另一条线路 → 真失败才报错；
// 看门狗改为「有无进展」判定（缓冲区增长/时间推进就不算卡死）。
// ============================================================================

export type PlayerProps = {
	/** 上游原始地址 */
	url: string;
	/** 同源签名代理地址 */
	proxyUrl?: string | null;
	/** 服务端建议的首选线路 */
	prefer?: "direct" | "proxy";
	poster?: string | null;
	title?: string;
	sourceId?: string;
	/** 续播起点（秒） */
	startTime?: number;
	autoPlay?: boolean;
	onEnded?: () => void;
	onProgress?: (currentTime: number, duration: number) => void;
	onNext?: () => void;
	onPrev?: () => void;
};

type Candidate = { mode: "proxy" | "direct"; url: string };
type Status = "idle" | "loading" | "ready" | "failed";

const WATCHDOG_MS = 16000; // 首帧超时（有进度则不计）
const MAX_RECOVER = 3; // 同一候选地址内最多自愈次数
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function isHlsUrl(u: string): boolean {
	return /\.m3u8($|[?#])/i.test(u) || /\/api\/stream\?u=[^&]*m3u8/i.test(u);
}

function canPlayNativeHls(video: HTMLVideoElement): boolean {
	return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

export default function Player(props: PlayerProps) {
	const { url, proxyUrl, prefer = "proxy", poster, title, sourceId, startTime, autoPlay = true } = props;

	const videoRef = useRef<HTMLVideoElement | null>(null);
	const hlsRef = useRef<Hls | null>(null);
	const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const stallRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const recoverRef = useRef(0);
	const reportedRef = useRef(false);
	const progressRef = useRef({ t: 0, buffered: 0, at: 0 });

	const [candIdx, setCandIdx] = useState(0);
	const [status, setStatus] = useState<Status>("idle");
	const [message, setMessage] = useState("");
	const [levels, setLevels] = useState<Level[]>([]);
	const [level, setLevel] = useState(-1);
	const [speed, setSpeed] = useState(1);
	const [needTap, setNeedTap] = useState(false);

	// 候选线路：首选在前，另一条兼得后。两条都挂才算真的失败。
	const candidates = useMemo<Candidate[]>(() => {
		const list: Candidate[] = [];
		const direct: Candidate | null = url ? { mode: "direct", url } : null;
		const proxy: Candidate | null = proxyUrl ? { mode: "proxy", url: proxyUrl } : null;
		const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
		// https 页面 + http 源 = 浏览器硬拦截，直连没有任何意义，直接排除
		const directUsable = !!direct && !(isHttps && direct.url.startsWith("http://"));
		if (prefer === "direct" && directUsable && direct) list.push(direct);
		if (proxy) list.push(proxy);
		if (prefer !== "direct" && directUsable && direct) list.push(direct);
		return list.length ? list : direct ? [direct] : [];
	}, [url, proxyUrl, prefer]);

	const current = candidates[candIdx];

	const clearTimers = useCallback(() => {
		if (watchdogRef.current) clearTimeout(watchdogRef.current);
		if (stallRef.current) clearInterval(stallRef.current);
		watchdogRef.current = null;
		stallRef.current = null;
	}, []);

	const destroyHls = useCallback(() => {
		if (hlsRef.current) {
			try {
				hlsRef.current.destroy();
			} catch {
				/* ignore */
			}
			hlsRef.current = null;
		}
	}, []);

	/** 上报播放结果（成功与失败都上报，才能算出真实成功率） */
	const report = useCallback(
		(ok: boolean, mode?: string) => {
			if (!sourceId || reportedRef.current) return;
			reportedRef.current = true;
			void fetch("/api/sources", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source_id: sourceId, ok, mode }),
				keepalive: true,
			}).catch(() => undefined);
		},
		[sourceId],
	);

	/** 当前候选地址彻底不行 -> 换下一条；都不行 -> 报错 */
	const failCandidate = useCallback(
		(reason: string) => {
			clearTimers();
			destroyHls();
			if (candIdx + 1 < candidates.length) {
				setMessage(`线路失败（${reason}），正在自动切换备用线路…`);
				setStatus("loading");
				setCandIdx((i) => i + 1);
				return;
			}
			setStatus("failed");
			setMessage(reason);
			report(false, current?.mode);
		},
		[candIdx, candidates.length, clearTimers, destroyHls, report, current?.mode],
	);

	// -------------------------------------------------------------- 挂载媒体
	useEffect(() => {
		const video = videoRef.current;
		if (!video || !current) return;

		let disposed = false;
		recoverRef.current = 0;
		reportedRef.current = false;
		setStatus("loading");
		setNeedTap(false);
		setLevels([]);
		setLevel(-1);
		progressRef.current = { t: 0, buffered: 0, at: Date.now() };

		const armWatchdog = () => {
			if (watchdogRef.current) clearTimeout(watchdogRef.current);
			watchdogRef.current = setTimeout(() => {
				if (disposed) return;
				// 只有「真的一点数据都没拉到」才判死
				const v = videoRef.current;
				const gotData = !!v && (v.readyState >= 2 || v.buffered.length > 0);
				if (!gotData) failCandidate("连接超时，上游无响应");
			}, WATCHDOG_MS);
		};

		const armStallCheck = () => {
			if (stallRef.current) clearInterval(stallRef.current);
			stallRef.current = setInterval(() => {
				const v = videoRef.current;
				if (!v || v.paused || v.ended) return;
				const buffered = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
				const p = progressRef.current;
				const moved = v.currentTime > p.t + 0.25 || buffered > p.buffered + 0.25;
				if (moved) {
					progressRef.current = { t: v.currentTime, buffered, at: Date.now() };
					return;
				}
				// 持续 25s 无任何进展 -> 先尝试自愈，再不行换线路
				if (Date.now() - p.at > 25000) {
					progressRef.current = { ...p, at: Date.now() };
					if (hlsRef.current && recoverRef.current < MAX_RECOVER) {
						recoverRef.current += 1;
						try {
							hlsRef.current.startLoad();
						} catch {
							/* ignore */
						}
					} else {
						failCandidate("播放长时间卡住，上游可能已断流");
					}
				}
			}, 5000);
		};

		const tryPlay = () => {
			if (!autoPlay) return;
			const p = video.play();
			if (p && typeof p.catch === "function") {
				p.catch(() => {
					// 自动播放策略拦截：先静音重试，再不行就提示点击
					video.muted = true;
					video.play().catch(() => setNeedTap(true));
				});
			}
		};

		const onLoadedMeta = () => {
			if (startTime && startTime > 5 && Number.isFinite(video.duration)) {
				try {
					video.currentTime = Math.min(startTime, video.duration - 5);
				} catch {
					/* ignore */
				}
			}
		};
		const onLoadedData = () => {
			if (watchdogRef.current) clearTimeout(watchdogRef.current);
			setStatus("ready");
			setMessage("");
			report(true, current.mode);
		};
		const onPlaying = () => {
			setStatus("ready");
			setNeedTap(false);
		};
		const onTimeUpdate = () => {
			if (props.onProgress && Number.isFinite(video.duration))
				props.onProgress(video.currentTime, video.duration);
		};
		const onEnded = () => props.onEnded?.();
		const onNativeError = () => {
			// 原生播放失败（非 hls.js 路径）
			if (hlsRef.current) return;
			const code = video.error?.code;
			const map: Record<number, string> = {
				1: "加载被中止",
				2: "网络错误（可能是跨域或防盗链）",
				3: "解码失败（编码不兼容）",
				4: "格式不支持或地址不可用",
			};
			failCandidate(map[code ?? 4] ?? "播放器错误");
		};

		video.addEventListener("loadedmetadata", onLoadedMeta);
		video.addEventListener("loadeddata", onLoadedData);
		video.addEventListener("playing", onPlaying);
		video.addEventListener("timeupdate", onTimeUpdate);
		video.addEventListener("ended", onEnded);
		video.addEventListener("error", onNativeError);

		destroyHls();
		video.removeAttribute("src");
		video.load();

		const useHlsJs = isHlsUrl(current.url) && Hls.isSupported() && !canPlayNativeHls(video);

		if (useHlsJs) {
			const hls = new Hls({
				enableWorker: true,
				lowLatencyMode: false,
				backBufferLength: 60,
				maxBufferLength: 30,
				maxMaxBufferLength: 90,
				manifestLoadingTimeOut: 12000,
				manifestLoadingMaxRetry: 3,
				levelLoadingMaxRetry: 3,
				fragLoadingTimeOut: 25000,
				fragLoadingMaxRetry: 4,
				startLevel: -1,
			});
			hlsRef.current = hls;
			hls.attachMedia(video);
			hls.loadSource(current.url);

			hls.on(Hls.Events.MANIFEST_PARSED, (_e: Events.MANIFEST_PARSED, data) => {
				setLevels(data.levels ?? []);
				tryPlay();
			});
			hls.on(Hls.Events.LEVEL_SWITCHED, (_e: Events.LEVEL_SWITCHED, data) => {
				setLevel(data.level);
			});
			hls.on(Hls.Events.ERROR, (_e: Events.ERROR, data: ErrorData) => {
				if (!data.fatal) return;
				if (recoverRef.current >= MAX_RECOVER) {
					failCandidate(describeHlsError(data));
					return;
				}
				recoverRef.current += 1;
				if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
					// 清单拉不到 = 跨域/防盗链，重试无意义，直接换线路
					if (
						data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
						data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR
					) {
						failCandidate(describeHlsError(data));
						return;
					}
					setMessage("网络波动，正在重试…");
					try {
						hls.startLoad();
					} catch {
						failCandidate(describeHlsError(data));
					}
				} else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					setMessage("解码异常，正在修复…");
					try {
						hls.recoverMediaError();
					} catch {
						failCandidate(describeHlsError(data));
					}
				} else {
					failCandidate(describeHlsError(data));
				}
			});
		} else {
			video.src = current.url;
			video.load();
			tryPlay();
		}

		armWatchdog();
		armStallCheck();

		return () => {
			disposed = true;
			clearTimers();
			destroyHls();
			video.removeEventListener("loadedmetadata", onLoadedMeta);
			video.removeEventListener("loadeddata", onLoadedData);
			video.removeEventListener("playing", onPlaying);
			video.removeEventListener("timeupdate", onTimeUpdate);
			video.removeEventListener("ended", onEnded);
			video.removeEventListener("error", onNativeError);
			try {
				video.pause();
				video.removeAttribute("src");
				video.load();
			} catch {
				/* ignore */
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [current?.url, current?.mode]);

	// 地址变化（切集/换源）时重置到首选线路
	useEffect(() => {
		setCandIdx(0);
		setStatus("loading");
		setMessage("");
	}, [url, proxyUrl]);

	// 键盘快捷键
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const v = videoRef.current;
			if (!v) return;
			const tag = (e.target as HTMLElement | null)?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			if (e.key === " ") {
				e.preventDefault();
				if (v.paused) void v.play();
				else v.pause();
			} else if (e.key === "ArrowRight") v.currentTime += 10;
			else if (e.key === "ArrowLeft") v.currentTime -= 10;
			else if (e.key === "ArrowUp") v.volume = Math.min(1, v.volume + 0.1);
			else if (e.key === "ArrowDown") v.volume = Math.max(0, v.volume - 0.1);
			else if (e.key.toLowerCase() === "f") void toggleFullscreen();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const toggleFullscreen = useCallback(async () => {
		const el = videoRef.current?.parentElement;
		if (!el) return;
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await el.requestFullscreen();
		} catch {
			/* ignore */
		}
	}, []);

	const togglePip = useCallback(async () => {
		const v = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
		if (!v?.requestPictureInPicture) return;
		try {
			if (document.pictureInPictureElement) await document.exitPictureInPicture();
			else await v.requestPictureInPicture();
		} catch {
			/* ignore */
		}
	}, []);

	const switchLine = useCallback(() => {
		if (candidates.length < 2) return;
		reportedRef.current = true; // 手动换线不计入源质量统计
		setStatus("loading");
		setMessage("");
		setCandIdx((i) => (i + 1) % candidates.length);
	}, [candidates.length]);

	const retry = useCallback(() => {
		reportedRef.current = false;
		recoverRef.current = 0;
		setStatus("loading");
		setMessage("");
		setCandIdx(0);
		// 强制重新挂载：先置空再恢复
		const v = videoRef.current;
		if (v && candidates[0]) {
			v.removeAttribute("src");
			v.load();
			if (!isHlsUrl(candidates[0].url) || !Hls.isSupported()) {
				v.src = candidates[0].url;
				void v.play().catch(() => undefined);
			}
		}
	}, [candidates]);

	const changeSpeed = useCallback((s: number) => {
		setSpeed(s);
		if (videoRef.current) videoRef.current.playbackRate = s;
	}, []);

	const changeLevel = useCallback((lv: number) => {
		setLevel(lv);
		if (hlsRef.current) hlsRef.current.currentLevel = lv;
	}, []);

	const externalUrl = useMemo(() => {
		if (typeof window === "undefined") return current?.url ?? "";
		const u = current?.url ?? "";
		return u.startsWith("/") ? window.location.origin + u : u;
	}, [current?.url]);

	const copyUrl = useCallback(() => {
		void navigator.clipboard?.writeText(externalUrl);
	}, [externalUrl]);

	const openVlc = useCallback(() => {
		window.location.href = "vlc://" + externalUrl;
	}, [externalUrl]);

	const downloadStrm = useCallback(() => {
		const blob = new Blob([externalUrl], { type: "text/plain" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = (title || "aurora-play").replace(/[\\/:*?"<>|]/g, "_") + ".strm";
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 3000);
	}, [externalUrl, title]);

	if (!current) {
		return (
			<div className="player-wrap">
				<div className="player-fail">
					<div className="player-fail-msg">没有可用的播放地址</div>
				</div>
			</div>
		);
	}

	return (
		<div className="player-wrap">
			<div className="player-frame">
				{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
				<video
					ref={videoRef}
					poster={poster ?? undefined}
					controls
					playsInline
					preload="metadata"
					/* 不要设 crossOrigin：<video> 一旦带上它，poster 图片也会变成 CORS 请求，
					   采集站图床没有 ACAO 头就直接被拒（控制台里那一堆 pic.*.com 报错）。
					   hls.js 是自己发 XHR 拉分片的，不依赖 video 元素的 crossOrigin。 */
					style={{ width: "100%", height: "100%", background: "#000" }}
				/>

				{status === "loading" && (
					<div className="player-overlay">
						<div className="player-spinner" />
						<div className="player-overlay-text">
							{message || (current.mode === "proxy" ? "正在通过加速线路连接…" : "正在直连片源…")}
						</div>
					</div>
				)}

				{needTap && status !== "failed" && (
					<button
						type="button"
						className="player-tap"
						onClick={() => {
							setNeedTap(false);
							void videoRef.current?.play();
						}}
					>
						▶ 点击播放
					</button>
				)}

				{status === "failed" && (
					<div className="player-fail">
						<div className="player-fail-msg">播放失败：{message}</div>
						<div className="player-fail-hint">
							已自动尝试：代理线路 / 直连线路 / 错误自愈。仍失败通常意味着上游已失效、需要付费或有地区限制，可以换一个片源重试。
						</div>
						<div className="player-fail-url">{externalUrl}</div>
						<div className="player-fail-actions">
							<button type="button" className="pill" onClick={retry}>
								重试
							</button>
							{candidates.length > 1 && (
								<button type="button" className="pill" onClick={switchLine}>
									换线路
								</button>
							)}
							<button type="button" className="pill" onClick={copyUrl}>
								复制地址
							</button>
							<button type="button" className="pill" onClick={openVlc}>
								VLC 打开
							</button>
							<button type="button" className="pill" onClick={downloadStrm}>
								下载 .strm
							</button>
						</div>
					</div>
				)}
			</div>

			<div className="player-bar">
				<span className={"player-tag " + (current.mode === "proxy" ? "player-tag-proxy" : "")}>
					{current.mode === "proxy" ? "加速线路" : "直连线路"}
				</span>
				{candidates.length > 1 && (
					<button type="button" className="pill" onClick={switchLine}>
						切换线路
					</button>
				)}
				{levels.length > 1 && (
					<select
						className="player-select"
						value={level}
						onChange={(e) => changeLevel(Number(e.target.value))}
						aria-label="清晰度"
					>
						<option value={-1}>自动清晰度</option>
						{levels.map((l, i) => (
							<option key={i} value={i}>
								{l.height ? l.height + "P" : Math.round((l.bitrate ?? 0) / 1000) + "kbps"}
							</option>
						))}
					</select>
				)}
				<select
					className="player-select"
					value={speed}
					onChange={(e) => changeSpeed(Number(e.target.value))}
					aria-label="倍速"
				>
					{SPEEDS.map((s) => (
						<option key={s} value={s}>
							{s}x
						</option>
					))}
				</select>
				<button type="button" className="pill" onClick={togglePip}>
					画中画
				</button>
				<button type="button" className="pill" onClick={toggleFullscreen}>
					全屏
				</button>
				<span className="header-spacer" />
				{props.onPrev && (
					<button type="button" className="pill" onClick={props.onPrev}>
						上一集
					</button>
				)}
				{props.onNext && (
					<button type="button" className="pill" onClick={props.onNext}>
						下一集
					</button>
				)}
			</div>
		</div>
	);
}

function describeHlsError(data: ErrorData): string {
	const d = String(data.details ?? "");
	if (/manifestLoadError|manifestLoadTimeOut/i.test(d))
		return "播放列表拉取失败（跨域 / 防盗链 / 上游挂掉）";
	if (/manifestParsingError/i.test(d)) return "播放列表格式错误（可能返回了错误页面）";
	if (/levelLoad|fragLoad/i.test(d)) return "视频分片拉取失败（上游不稳定）";
	if (/bufferAppend|bufferStalled|bufferAddCodec/i.test(d)) return "解码失败（编码格式不兼容）";
	if (/keyLoad/i.test(d)) return "解密密钥拉取失败";
	return d || "未知错误";
}
