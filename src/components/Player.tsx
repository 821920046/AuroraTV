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
	/**
	 * 用于按「剧」记忆片头标记。
	 * 缺省时「跳过片头」不可用 —— 没有它就没法区分这是哪部剧。
	 */
	vodId?: string;
	/** 续播起点（秒） */
	startTime?: number;
	autoPlay?: boolean;
	onEnded?: () => void;
	onProgress?: (currentTime: number, duration: number) => void;
	onNext?: () => void;
	onPrev?: () => void;
	/**
	 * 所有候选线路都失败时调用（代理 + 直连都试过了）。
	 *
	 * 返回 true 表示「外部已接管」—— 通常是自动切换到另一个片源重试。
	 * 此时播放器**不能**再显示失败页：否则用户会看到失败页一闪，紧接着画面又出来了，
	 * 观感比多等一秒差得多。
	 *
	 * currentTime 是失败那一刻的播放位置，换源后据此续播 ——
	 * 看到第 30 分钟突然断流、换源后又从片头开始，比直接报错更让人恼火。
	 */
	onExhausted?: (currentTime: number) => boolean;
	/**
	 * 快播完时调用一次，供外部预热下一集（取地址 -> 清单 -> 首个分片）。
	 *
	 * 刻意做成「回调」而不是播放器内部实现：只有页面层知道下一集是哪一集、
	 * 该走哪个片源；播放器连「有没有下一集」都不该关心。
	 */
	onPreloadNext?: () => void;
};

type Candidate = { mode: "proxy" | "direct"; url: string };
type Status = "idle" | "loading" | "ready" | "failed";

const WATCHDOG_MS = 16000; // 首帧超时（有进度则不计）
const MAX_RECOVER = 3; // 同一候选地址内最多自愈次数
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// ---------------------------------------------------------------- 播放偏好

/**
 * 记住倍速 / 音量 / 静音。
 *
 * 【为什么值得单独做】
 * 追剧的人几乎都会固定一个倍速。旧版每次切集、每次刷新都回到 1x，
 * 一集剧要手动调十几次 —— 这是「观看体验」里最容易被忽略但最高频的摩擦点。
 */
const PREFS_KEY = "aurora:player:prefs";

type Prefs = { speed: number; volume: number; muted: boolean };

const DEFAULT_PREFS: Prefs = { speed: 1, volume: 1, muted: false };

function loadPrefs(): Prefs {
	if (typeof window === "undefined") return DEFAULT_PREFS;
	try {
		const raw = window.localStorage.getItem(PREFS_KEY);
		if (!raw) return DEFAULT_PREFS;
		const p = JSON.parse(raw) as Partial<Prefs>;
		return {
			// 逐项校验：localStorage 是用户可改的，脏数据不能让播放器崩掉
			speed: typeof p.speed === "number" && p.speed > 0 && p.speed <= 4 ? p.speed : 1,
			volume: typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : 1,
			muted: p.muted === true,
		};
	} catch {
		return DEFAULT_PREFS;
	}
}

function savePrefs(patch: Partial<Prefs>): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
	} catch {
		/* 隐私模式下可能写失败，忽略 */
	}
}

// ---------------------------------------------------------------- 片头标记

/**
 * 按「剧」而不是按「集」记忆片头时长。
 * 同一部剧每一集的片头长度基本一致，按集存等于让用户每集都标一次 —— 没人会这么干。
 */
const SKIP_KEY_PREFIX = "aurora:skip:";

type SkipMark = { intro?: number };

function skipKey(sourceId?: string, vodId?: string): string | null {
	if (!sourceId || !vodId) return null;
	return SKIP_KEY_PREFIX + sourceId + ":" + vodId;
}

function loadSkip(sourceId?: string, vodId?: string): SkipMark {
	const key = skipKey(sourceId, vodId);
	if (typeof window === "undefined" || !key) return {};
	try {
		const raw = window.localStorage.getItem(key);
		if (!raw) return {};
		const m = JSON.parse(raw) as Partial<SkipMark>;
		// 逐项校验：localStorage 用户可改，脏数据不能让播放器跳到离谱的位置
		return {
			intro:
				typeof m.intro === "number" && m.intro > 0 && m.intro < 3600 ? m.intro : undefined,
		};
	} catch {
		return {};
	}
}

function saveSkip(sourceId: string | undefined, vodId: string | undefined, mark: SkipMark): void {
	const key = skipKey(sourceId, vodId);
	if (typeof window === "undefined" || !key) return;
	try {
		if (mark.intro === undefined) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, JSON.stringify(mark));
	} catch {
		/* ignore */
	}
}

/** 位移文案：+10 / -10 / 0 */
function fmtDelta(n: number): string {
	return (n > 0 ? "+" : "") + n;
}

/** 移动端手势的常量 */
const DOUBLE_TAP_MS = 300; // 两次点击间隔小于它才算双击
const SEEK_STEP = 10; // 双击快进 / 后退的秒数
const CONTROLS_ZONE_PX = 56; // 底部原生控件区域高度，这段让给浏览器
const VOLUME_SWIPE_PX = 220; // 上下滑动多少像素对应音量 0 → 1
const NEXT_COUNTDOWN_SEC = 8; // 播完后自动播放下一集的倒计时
/**
 * 距结束多少秒开始预热下一集。
 *
 * 不能太早：清单的 cache-control 只有 30s，提前两分钟拉等于白拉，
 * 真切集时还是得重新走一趟。15s 的提前量刚好覆盖「倒计时 8s + 用户点立即播放」，
 * 清单仍在有效期内，而分片（max-age=600）更是稳的。
 */
const PRELOAD_LEAD_SEC = 15;
/** 短于这个时长的片子不做预热 —— 一开播就满足条件，等于无条件多下一份首片 */
const PRELOAD_MIN_DURATION_SEC = 180;

function isHlsUrl(u: string): boolean {
	return /\.m3u8($|[?#])/i.test(u) || /\/api\/stream\?u=[^&]*m3u8/i.test(u);
}

function canPlayNativeHls(video: HTMLVideoElement): boolean {
	return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

export default function Player(props: PlayerProps) {
	const {
		url,
		proxyUrl,
		prefer = "proxy",
		poster,
		title,
		sourceId,
		vodId,
		startTime,
		autoPlay = true,
	} = props;

	const videoRef = useRef<HTMLVideoElement | null>(null);
	const hlsRef = useRef<Hls | null>(null);
	const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const stallRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const recoverRef = useRef(0);
	const reportedRef = useRef(false);
	/** 用户手动换线路时置位：手动换线不代表片源真实质量，不计入上报统计 */
	const manualRef = useRef(false);
	const progressRef = useRef({ t: 0, buffered: 0, at: 0 });
	/** 倍速用 ref 同步保存：它要能被「挂载媒体」的 effect 读到，但不该进那个 effect 的依赖 */
	const speedRef = useRef(1);
	/** onExhausted 用 ref 存最新值，避免把它塞进 failCandidate 的依赖导致回调频繁重建 */
	const onExhaustedRef = useRef(props.onExhausted);
	onExhaustedRef.current = props.onExhausted;
	/** 同理：倒计时的 effect 不该因为父组件每次渲染传新函数而重跑 */
	const onNextRef = useRef(props.onNext);
	onNextRef.current = props.onNext;
	const skipRef = useRef<SkipMark>({});
	const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** 预热下一集只在「临近结束」触发一次；Player 换集会重挂，所以普通 ref 就够 */
	const preloadFiredRef = useRef(false);
	/** 同 onNextRef：预热回调不该进 timeupdate 所在 effect 的依赖 */
	const onPreloadNextRef = useRef(props.onPreloadNext);
	onPreloadNextRef.current = props.onPreloadNext;

	const [candIdx, setCandIdx] = useState(0);
	const [status, setStatus] = useState<Status>("idle");
	const [message, setMessage] = useState("");
	const [levels, setLevels] = useState<Level[]>([]);
	const [level, setLevel] = useState(-1);
	const [speed, setSpeed] = useState(1);
	const [needTap, setNeedTap] = useState(false);
	/** 每次 +1 都强制重挂媒体（见 retry 的说明） */
	const [reloadKey, setReloadKey] = useState(0);
	/** 该剧的片头标记 */
	const [skip, setSkip] = useState<SkipMark>({});
	/** 当前是否该显示「跳过片头」 */
	const [showSkipIntro, setShowSkipIntro] = useState(false);
	/** 手势的瞬时提示（+10 秒 / 音量 60%） */
	const [hint, setHint] = useState("");
	/** 播完后的下一集倒计时，null 表示不在倒计时 */
	const [nextIn, setNextIn] = useState<number | null>(null);

	const flashHint = useCallback((text: string) => {
		setHint(text);
		if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
		hintTimerRef.current = setTimeout(() => setHint(""), 800);
	}, []);

	// 卸载时清掉提示的定时器：切集会让 Player 重挂（key 里带了 url），
	// 不清就会对着已卸载的组件 setState。
	useEffect(
		() => () => {
			if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
		},
		[],
	);

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
			// manualRef：用户手动切的线路，其成败不能算到这个片源头上，否则会污染健康评分
			if (!sourceId || reportedRef.current || manualRef.current) return;
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
			// 【顺序很关键】先如实上报，再决定要不要自动换源。
			// 不能因为「换个源就播出来了」就当作成功：这个源确实失败了，
			// 不上报它就不会被降权，下次还会被优先选中 —— 自动换源会变成
			// 「每次都先失败一次再绕开」，把问题永久掩盖掉。
			report(false, current?.mode);

			// 代理与直连都挂了。再问外部有没有别的片源能接管 ——
			// 片源质量参差是这类项目的常态，自动换源比让用户自己点「换源」有用得多。
			// 放在 setStatus("failed") 之前，否则失败页会先闪一下。
			const at = videoRef.current?.currentTime ?? 0;
			if (onExhaustedRef.current?.(at)) {
				setStatus("loading");
				setMessage("当前片源不可用，正在自动切换片源…");
				return;
			}
			setStatus("failed");
			setMessage(reason);
		},
		[candIdx, candidates.length, clearTimers, destroyHls, report, current?.mode],
	);

	// -------------------------------------------------------------- 恢复播放偏好
	// 刻意放在「挂载媒体」effect 之前：先把 muted / volume 设好，
	// 媒体那边的 tryPlay() 才拿得到正确的初始状态 —— 上次静音的用户能直接自动播放，
	// 不会被浏览器自动播放策略拦下。
	// 也不能拿 localStorage 当 useState 的初始值：Player 会被 SSR 渲染一次，
	// 那样会造成 hydration 前后不一致。
	useEffect(() => {
		const p = loadPrefs();
		speedRef.current = p.speed;
		setSpeed(p.speed);
		const v = videoRef.current;
		if (v) {
			v.volume = p.volume;
			v.muted = p.muted;
			v.playbackRate = p.speed;
		}
	}, []);

	// 用户拖音量条 / 点静音也要记住
	useEffect(() => {
		const v = videoRef.current;
		if (!v) return;
		const onVolume = () => savePrefs({ volume: v.volume, muted: v.muted });
		v.addEventListener("volumechange", onVolume);
		return () => v.removeEventListener("volumechange", onVolume);
	}, []);

	// -------------------------------------------------------------- 挂载媒体
	useEffect(() => {
		const video = videoRef.current;
		if (!video || !current) return;

		let disposed = false;
		recoverRef.current = 0;
		// 手动换线时保持「已上报」状态，让本次挂载不再上报（manualRef 读后即清）
		reportedRef.current = manualRef.current;
		manualRef.current = false;
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
			// 「跳过片头」只在还没过片头时出现。setState 传函数时值没变会 bail out，
			// 所以这里不会因为每秒 4 次的 timeupdate 造成额外渲染。
			const intro = skipRef.current.intro;
			const should = intro !== undefined && video.currentTime < intro - 1;
			setShowSkipIntro((prev) => (prev === should ? prev : should));

			// 临近结束预热下一集。timeupdate 每秒触发 4 次，靠 ref 保证只发一次。
			if (
				!preloadFiredRef.current &&
				Number.isFinite(video.duration) &&
				video.duration >= PRELOAD_MIN_DURATION_SEC &&
				video.duration - video.currentTime <= PRELOAD_LEAD_SEC
			) {
				preloadFiredRef.current = true;
				onPreloadNextRef.current?.();
			}
		};
		const onEnded = () => {
			// 有下一集就先走可取消的倒计时；没有则维持原有的一次性回调
			if (onNextRef.current) {
				setNextIn(NEXT_COUNTDOWN_SEC);
				return;
			}
			props.onEnded?.();
		};
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
		// 倍速是元素属性，重挂媒体后必须重新应用 —— 否则每切一集都会悄悄回到 1x
		video.playbackRate = speedRef.current;

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
	}, [current?.url, current?.mode, reloadKey]);

	// 地址变化（切集/换源）时重置到首选线路
	useEffect(() => {
		manualRef.current = false;
		setCandIdx(0);
		setStatus("loading");
		setMessage("");
	}, [url, proxyUrl]);

	// -------------------------------------------------------------- 片头标记
	// 依赖 sourceId / vodId 而不是 url：同一部剧切集时组件不会重挂，
	// 但片头标记是按「剧」共享的，不需要每次重新读。
	useEffect(() => {
		const m = loadSkip(sourceId, vodId);
		skipRef.current = m;
		setSkip(m);
		setShowSkipIntro(false);
	}, [sourceId, vodId]);

	const markIntro = useCallback(() => {
		const v = videoRef.current;
		if (!v) return;
		const t = Math.floor(v.currentTime);
		// 0 秒不是合法的「片头结束点」，而且 loadSkip 会把它当成脏数据丢掉 ——
		// 存下去只会让按钮显示「片头 0s」却永远不触发，不如当场说清楚。
		if (t <= 0) {
			flashHint("请先播放到片头结束的位置再标记");
			return;
		}
		const next: SkipMark = {};
		// 在同一位置再点一次 = 取消标记，省掉一个「清除」按钮
		if (skipRef.current.intro !== undefined && Math.abs(skipRef.current.intro - t) < 3) {
			flashHint("已取消片头标记");
		} else {
			next.intro = t;
			flashHint("片头结束点已设为 " + t + " 秒");
		}
		skipRef.current = next;
		setSkip(next);
		saveSkip(sourceId, vodId, next);
	}, [sourceId, vodId, flashHint]);

	const jumpIntro = useCallback(() => {
		const v = videoRef.current;
		const intro = skipRef.current.intro;
		if (!v || intro === undefined) return;
		v.currentTime = intro;
		setShowSkipIntro(false);
		flashHint("已跳过片头");
	}, [flashHint]);

	// -------------------------------------------------------------- 下一集倒计时
	useEffect(() => {
		if (nextIn === null) return;
		if (nextIn <= 0) {
			setNextIn(null);
			onNextRef.current?.();
			return;
		}
		const id = setTimeout(() => setNextIn((n) => (n === null ? null : n - 1)), 1000);
		return () => clearTimeout(id);
	}, [nextIn]);

	// -------------------------------------------------------------- 移动端手势
	// 用原生监听而不是 React 的 onTouch*：滑动调音量必须 preventDefault 阻止页面滚动，
	// 而 React 的合成事件绑在 root 上且默认 passive，preventDefault 会被忽略。
	useEffect(() => {
		const el = videoRef.current;
		if (!el) return;

		let start: { x: number; y: number; volume: number } | null = null;
		let mode: "none" | "volume" | "seek" = "none";
		let lastTap = 0;
		let lastSide: "left" | "right" | null = null;

		/** 按秒跳转，并给出提示。定义在 effect 内，省得把依赖链再拉长一层。 */
		const seekBy = (v: HTMLVideoElement, delta: number) => {
			const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
			v.currentTime = Math.max(0, Math.min(dur, v.currentTime + delta));
			flashHint(fmtDelta(delta) + " 秒");
		};

		const onStart = (e: TouchEvent) => {
			const v = videoRef.current;
			if (!v || e.touches.length !== 1) {
				start = null;
				return;
			}
			const t = e.touches[0];
			const rect = el.getBoundingClientRect();
			// 底部那一条是原生控件，必须让给浏览器 —— 抢了它用户就没法拖进度条
			if (t.clientY > rect.bottom - CONTROLS_ZONE_PX) {
				start = null;
				return;
			}
			start = { x: t.clientX, y: t.clientY, volume: v.volume };
			mode = "none";
		};

		const onMove = (e: TouchEvent) => {
			const v = videoRef.current;
			if (!start || !v) return;
			const t = e.touches[0];
			const dx = t.clientX - start.x;
			const dy = t.clientY - start.y;
			if (mode === "none") {
				// 先判方向再决定是哪种手势，避免轻微抖动就触发
				if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
				mode = Math.abs(dy) > Math.abs(dx) ? "volume" : "seek";
			}
			e.preventDefault();
			if (mode === "volume") {
				// 屏幕坐标 y 向下为正，所以上滑要取负
				v.volume = Math.max(0, Math.min(1, start.volume - dy / VOLUME_SWIPE_PX));
				flashHint("音量 " + Math.round(v.volume * 100) + "%");
			} else {
				flashHint(fmtDelta(Math.round(dx / 12)) + " 秒");
			}
		};

		const onEnd = (e: TouchEvent) => {
			const v = videoRef.current;
			const s = start;
			const m = mode;
			start = null;
			mode = "none";
			if (!v || !s) return;

			const t = e.changedTouches[0];

			if (m === "seek") {
				// 松手才真正跳转：拖动过程中反复 seek 会让播放器不断重新缓冲
				const delta = Math.round((t.clientX - s.x) / 12);
				if (delta !== 0) seekBy(v, delta);
				return;
			}
			if (m !== "none") return; // 音量滑动结束，不当作点击

			const rect = el.getBoundingClientRect();
			if (t.clientY > rect.bottom - CONTROLS_ZONE_PX) return;
			const side: "left" | "right" = t.clientX - rect.left < rect.width / 2 ? "left" : "right";
			const now = Date.now();
			if (lastSide === side && now - lastTap < DOUBLE_TAP_MS) {
				lastTap = 0;
				lastSide = null;
				const step = side === "right" ? SEEK_STEP : -SEEK_STEP;
				seekBy(v, step);
				return;
			}
			lastTap = now;
			lastSide = side;
		};

		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd, { passive: true });
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
		};
	}, [flashHint]);

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
		// toggleFullscreen 是 deps 为 [] 的 useCallback，引用稳定，不会导致反复注册。
	}, [toggleFullscreen]);

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
		manualRef.current = true; // 手动换线不计入源质量统计
		setStatus("loading");
		setMessage("");
		setCandIdx((i) => (i + 1) % candidates.length);
	}, [candidates.length]);

	const retry = useCallback(() => {
		manualRef.current = false;
		recoverRef.current = 0;
		setStatus("loading");
		setMessage("");
		setCandIdx(0);
		// 【为什么需要 reloadKey】candIdx 本来就是 0 时，setCandIdx(0) 不会引发重渲染，
		// 挂载媒体的 effect 也就不会重跑；而 HLS 走的是 hls.js 分支，从不设置 video.src，
		// 于是「重试」按钮在 hls.js 路径下等于完全没有反应。reloadKey 强制 effect 重挂媒体，
		// 直连与 hls.js 两条路径都能真正重试。
		setReloadKey((k) => k + 1);
	}, []);

	const changeSpeed = useCallback((s: number) => {
		setSpeed(s);
		speedRef.current = s;
		if (videoRef.current) videoRef.current.playbackRate = s;
		savePrefs({ speed: s });
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

				{/* 手势的瞬时反馈：+10 秒 / 音量 60%。放在正中央，眼睛不用移动 */}
				{hint && <div className="player-hint">{hint}</div>}

				{showSkipIntro && status === "ready" && (
					<button type="button" className="player-skip" onClick={jumpIntro}>
						跳过片头（{skip.intro} 秒）
					</button>
				)}

				{nextIn !== null && (
					<div className="player-next">
						<span className="player-next-text">{nextIn} 秒后播放下一集</span>
						<button
							type="button"
							className="pill"
							onClick={() => {
								setNextIn(null);
								onNextRef.current?.();
							}}
						>
							立即播放
						</button>
						<button type="button" className="pill" onClick={() => setNextIn(null)}>
							取消
						</button>
					</div>
				)}

				{status === "failed" && (
					<div className="player-fail">
						<div className="player-fail-msg">播放失败：{message}</div>
						<div className="player-fail-hint">
							已自动尝试：代理线路 / 直连线路 / 错误自愈 / 全部备用片源。仍失败通常意味着上游已失效、需要付费或有地区限制，可以稍后重试或换一部片。
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
				{vodId ? (
					<button
						type="button"
						className={"pill" + (skip.intro !== undefined ? " on" : "")}
						onClick={markIntro}
						title="把当前位置设为片头结束点；在同一位置再点一次可取消。标记按「剧」保存，下一集自动生效。"
					>
						{skip.intro !== undefined ? `片头 ${skip.intro}s` : "标记片头"}
					</button>
				) : null}
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
