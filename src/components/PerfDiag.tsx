"use client";

import { useEffect, useState } from "react";
import { fmtBytes, summarize, verdictOf, type PerfRow } from "@/lib/perfDiag";

// ============================================================================
// 页内性能诊断浮层（地址栏加 `?diag=1` 才出现）
// ----------------------------------------------------------------------------
// 存在的理由只有一个：手机上没法开 DevTools。夸克这类浏览器裁掉了远程调试
// 通道，`chrome://inspect` 里看不到它们的页面；手机本身也没有控制台。
// 把 PerformanceResourceTiming 的统计做成一个可关闭的浮层，是不依赖电脑的
// 唯一办法。
//
// 它不做任何埋点、不发任何请求 —— 全部数据都是浏览器已经记录在本地的。
// ============================================================================

const TONE_CLASS: Record<"ok" | "warn" | "bad", string> = {
	ok: "is-ok",
	warn: "is-warn",
	bad: "is-bad",
};

const KIND_LABEL: Record<PerfRow["kind"], string> = {
	img: "海报 /api/img",
	stream: "播放 /api/stream",
};

export default function PerfDiag() {
	const [rows, setRows] = useState<PerfRow[]>([]);
	const [open, setOpen] = useState(true);

	useEffect(() => {
		if (!open) return;
		const tick = () => {
			// resource timing 由浏览器自己维护，上限约 250 条，不会无限增长。
			const all = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
			setRows(summarize(all));
		};
		tick();
		const id = window.setInterval(tick, 1000);
		return () => window.clearInterval(id);
	}, [open]);

	if (!open) return null;

	return (
		<div className="perf-diag" role="status" aria-live="polite">
			<div className="perf-diag-head">
				<strong>性能诊断</strong>
				<span className="perf-diag-hint">每秒刷新 · 数值单位 ms</span>
				<button type="button" className="perf-diag-close" onClick={() => setOpen(false)}>
					关闭
				</button>
			</div>

			{rows.length === 0 ? (
				<p className="perf-diag-empty">还没有 /api/img 或 /api/stream 请求。搜索一次或播一集再看。</p>
			) : (
				rows.map((r) => {
					const v = verdictOf(r);
					return (
						<div className="perf-diag-row" key={r.kind}>
							<div className="perf-diag-name">
								{KIND_LABEL[r.kind]} · {r.n} 次
								{r.cached > 0 ? " · 缓存 " + r.cached : ""}
							</div>
							<div className="perf-diag-nums">
								<span>
									TTFB 中位 <b>{r.ttfbP50}</b>
								</span>
								<span>
									最大 <b>{r.ttfbMax}</b>
								</span>
								<span>
									上游 <b>{r.upstreamP50 ?? "—"}</b>
								</span>
								<span>
									下载 <b>{r.downP50}</b>
								</span>
								<span className="perf-diag-bytes">{fmtBytes(r.bytes)}</span>
							</div>
							<div className={"perf-diag-verdict " + TONE_CLASS[v.tone]}>{v.text}</div>
						</div>
					);
				})
			)}
		</div>
	);
}
