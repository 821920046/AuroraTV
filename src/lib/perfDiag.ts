// ============================================================================
// 页面内性能诊断（`?diag=1`）
// ----------------------------------------------------------------------------
// 【要回答的问题】
// 手机上「海报很慢」「播放卡顿」，光看一个 TTFB 分不清是谁慢：
//   - 上游图床/源站慢     -> 换源、上图片压缩，代码改了也没用
//   - Worker 自己慢       -> 验签、限流、DoH 冷启动，是我们的问题
//   - 浏览器缓存没命中    -> URL 不稳定，签名网格没起作用
//   - 并发排队            -> 每条都不慢，但加起来很久
//
// 数据全部来自浏览器自己的 PerformanceResourceTiming，加上 Worker 用
// `server-timing` 头暴露的 upstream / worker 两段耗时。不引入任何埋点服务。
//
// 【为什么不直接看 DevTools】
// 夸克这类国产浏览器裁掉了远程调试通道，`chrome://inspect` 里看不到它们的页面；
// 手机上也没有控制台。把统计做成页内浮层，是唯一不依赖电脑的办法。
//
// 【本模块刻意不 import 任何 DOM 类型】
// 单测跑在 Node 的 strip-only 模式下，没有 PerformanceResourceTiming。
// 用结构化的 Entry 类型描述「我们实际读的那几个字段」，
// 组件里把真实对象传进来即可，测试则直接构造字面量。
// ============================================================================

/** 只描述本模块真正读取的字段，便于单测构造。 */
export type Entry = {
	name: string;
	requestStart: number;
	responseStart: number;
	responseEnd: number;
	transferSize: number;
	serverTiming?: ReadonlyArray<{ name: string; duration: number }>;
};

export type PerfRow = {
	kind: "img" | "stream";
	/** 采样到的请求条数 */
	n: number;
	/** TTFB 中位数 / 最大值（毫秒） */
	ttfbP50: number;
	ttfbMax: number;
	/** 下载耗时中位数 */
	downP50: number;
	/** Worker 内部回源耗时中位数（取不到 server-timing 时为 null） */
	upstreamP50: number | null;
	/** 命中浏览器缓存（transferSize 为 0）的条数 */
	cached: number;
	/** 累计传输字节数（缓存命中不计） */
	bytes: number;
};

/** URL -> 分类。只关心两条热点链路，其余一律忽略。 */
export function kindOf(name: string): "img" | "stream" | null {
	let path: string;
	try {
		path = new URL(name, "https://x.invalid").pathname;
	} catch {
		return null;
	}
	if (path === "/api/img") return "img";
	if (path === "/api/stream") return "stream";
	return null;
}

/** 分位数。空数组返回 0；p 超出 [0,1] 会被夹紧。 */
export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const clamped = Math.min(1, Math.max(0, p));
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * clamped));
	return Math.round(sorted[idx]);
}

/**
 * 一条资源记录是否可用。
 *
 * `responseStart === 0` 意味着跨域且对方没给 Timing-Allow-Origin —— 拿不到
 * 分段数据。我们的 /api/img、/api/stream 都同源，正常不会出现；
 * 但一旦出现，把它算进 TTFB 会得到一个负的垃圾值。
 */
function usable(e: Entry): boolean {
	return (
		Number.isFinite(e.requestStart) &&
		Number.isFinite(e.responseStart) &&
		e.responseStart > 0 &&
		e.requestStart > 0 &&
		e.responseStart >= e.requestStart
	);
}

/** Worker 自报的回源耗时。 */
function upstreamOf(e: Entry): number | null {
	const st = e.serverTiming;
	if (!st) return null;
	for (const s of st) {
		if (s && s.name === "upstream" && Number.isFinite(s.duration)) {
			return Math.max(0, Math.round(s.duration));
		}
	}
	return null;
}

/**
 * 把原始资源记录聚合成两张表。
 * 顺序固定为 img、stream —— 界面顺序不该随数据抖动。
 */
export function summarize(entries: ReadonlyArray<Entry>): PerfRow[] {
	const groups: Record<"img" | "stream", Entry[]> = { img: [], stream: [] };
	for (const e of entries) {
		const kind = kindOf(e.name);
		if (kind) groups[kind].push(e);
	}

	const rows: PerfRow[] = [];
	for (const kind of ["img", "stream"] as const) {
		const list = groups[kind].filter(usable);
		if (list.length === 0) continue;

		const ttfb: number[] = [];
		const down: number[] = [];
		const upstream: number[] = [];
		let cached = 0;
		let bytes = 0;

		for (const e of list) {
			ttfb.push(e.responseStart - e.requestStart);
			down.push(Math.max(0, e.responseEnd - e.responseStart));
			const up = upstreamOf(e);
			if (up !== null) upstream.push(up);
			// transferSize 为 0 表示没走网络（内存/磁盘缓存），也可能是跨域信息缺失；
			// 这里两条链路都同源，所以 0 就是缓存命中。
			if (e.transferSize === 0) cached += 1;
			else if (e.transferSize > 0) bytes += e.transferSize;
		}

		rows.push({
			kind,
			n: list.length,
			ttfbP50: percentile(ttfb, 0.5),
			ttfbMax: percentile(ttfb, 1),
			downP50: percentile(down, 0.5),
			upstreamP50: upstream.length > 0 ? percentile(upstream, 0.5) : null,
			cached,
			bytes,
		});
	}
	return rows;
}

export type Verdict = {
	/** 一句话结论，直接显示给用户 */
	text: string;
	/** 结论的严重程度，决定配色 */
	tone: "ok" | "warn" | "bad";
};

/**
 * 把一行统计翻译成人话。
 *
 * 判据全部是「比值」而不是绝对毫秒 —— 4G 和 WiFi 的绝对耗时差一倍以上，
 * 但「回源占 TTFB 的几成」这个比例是稳定的，换网络也成立。
 */
export function verdictOf(row: PerfRow): Verdict {
	// 缓存命中的请求 transferSize 为 0，它们的 TTFB 接近 0，会把中位数拉得很漂亮，
	// 但那只说明「第二次打开快」，不代表第一次慢的问题解决了。
	if (row.cached > 0 && row.cached >= row.n / 2) {
		return { text: "多数命中浏览器缓存，这次的数字不代表首次加载", tone: "ok" };
	}
	if (row.upstreamP50 === null) {
		return { text: "拿不到 server-timing，无法区分回源与 Worker 开销", tone: "warn" };
	}
	const share = row.ttfbP50 > 0 ? row.upstreamP50 / row.ttfbP50 : 0;
	if (row.ttfbP50 >= 800 && share >= 0.7) {
		return { text: "回源是瓶颈（上游站点慢），改代码没用，要换源或加图片压缩", tone: "bad" };
	}
	if (row.ttfbP50 >= 800) {
		return { text: "Worker 自身开销偏大，去查 DoH 冷启动与限流写 Cache", tone: "warn" };
	}
	if (row.ttfbP50 >= 300) {
		return { text: "单次不算慢，慢在并发排队（同时请求太多）", tone: "warn" };
	}
	return { text: "这一段健康", tone: "ok" };
}

/** 字节数转成人看的单位。 */
export function fmtBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1024) return n + " B";
	if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
	return (n / 1024 / 1024).toFixed(1) + " MB";
}
