"use client";

import { useEffect } from "react";

/**
 * 路由级错误边界（第二层）。
 *
 * 第一层是包住播放器的 <ErrorBoundary>（见 components/ErrorBoundary.tsx）——
 * 它把爆炸半径关在播放区。这一层兜住其余部分：搜索、结果列表、直播列表。
 *
 * 没有它时，客户端渲染期抛出的异常会一路冒到根，
 * Next 在生产环境显示默认错误页，导航栏一起消失 —— 用户连「回首页」都找不到。
 * 有了它，layout（含 SiteHeader）仍然在，用户随时能离开这一页。
 *
 * 只记录不接管：具体错误的恢复策略在各功能自己的边界里做，
 * 这里统一给「重试」和「看得见的错误编号」。
 */
export default function Error({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		// digest 是服务端渲染阶段的错误指纹，用户报错时带上它能对上日志
		console.error("[error.tsx] 页面崩溃：", error, error.digest ? "digest=" + error.digest : "");
	}, [error]);

	return (
		<div className="section">
			<div className="empty">
				<div className="emoji">💥</div>
				<h3>这一页出错了</h3>
				<p>
					某个部分崩了。点「重试」重新加载；若反复出现，请把浏览器控制台里的报错
					{error.digest ? "和下面的错误编号" : ""}反馈给站长。
				</p>
				{error.digest && <p className="card-meta">错误编号 {error.digest}</p>}
				<div className="player-fail-actions">
					<button type="button" className="pill" onClick={reset}>
						重试
					</button>
				</div>
			</div>
		</div>
	);
}
