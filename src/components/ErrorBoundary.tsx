"use client";

import {
	cloneElement,
	type ErrorInfo,
	type ReactElement,
	type ReactNode,
	isValidElement,
	Component,
} from "react";

/**
 * 通用错误边界。
 *
 * 【为什么需要它】
 * 播放器是整页最复杂的客户端组件：手势、定时器、hls.js 回调、
 * localStorage 脏数据全叠在一起。React 的规则是 —— 渲染期抛出的异常
 * 会一路冒到最近的错误边界，没有边界就整棵树卸载。表现在用户手里
 * 就是「白屏」：搜索框、结果列表、导航一起消失，只剩一片空白。
 * 一层边界把爆炸半径关在播放区里。
 *
 * 【为什么重试要换 key】
 * 只把 error 清掉是不够的：崩溃的那个实例内部 state 可能已经坏了，
 * React 会复用同一实例把它原样带回来。epoch 参与 key 让子树整棵重挂，
 * 等价于用户刷新页面但只重播这一块。
 */
type Props = {
	children: ReactNode;
	/** 兜底标题 */
	label?: string;
	/** 兜底补充说明 */
	hint?: string;
};

type State = { error: Error | null; epoch: number };

export default class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null, epoch: 0 };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// 用户设备上的控制台没人看，但完整堆栈是唯一能定位问题的线索。
		// 至少在控制台以可读形式出现，而不是被 React 吞掉。
		console.error("[ErrorBoundary] 子树渲染崩溃：", error, info.componentStack);
	}

	private reset = (): void => {
		this.setState((s) => ({ error: null, epoch: s.epoch + 1 }));
	};

	render() {
		const { error, epoch } = this.state;
		const child = this.props.children;

		if (!error) {
			if (!isValidElement(child)) return child;
			// 保留原子女自己的 key（切集靠它重挂），再拼上 epoch —— 两条重挂路径互不干扰
			const own = typeof child.key === "string" && child.key ? child.key + ":" : "";
			return cloneElement(child as ReactElement<Record<string, unknown>>, {
				key: own + epoch,
			});
		}

		return (
			<div className="player-wrap">
				{/* 必须套 .player-frame：.player-fail 是绝对定位浮层，
				    没有这个定位上下文会蹿到页面上其他地方去 */}
				<div className="player-frame">
					<div className="player-fail">
						<div className="player-fail-msg">{this.props.label ?? "这块内容出错了"}</div>
						<div className="player-fail-hint">
							{this.props.hint ??
								"页面其他部分不受影响。点「重试」重新加载这一块；若反复出现，请把浏览器控制台的报错反馈给站长。"}
						</div>
						<div className="player-fail-actions">
							<button type="button" className="pill" onClick={this.reset}>
								重试
							</button>
						</div>
					</div>
				</div>
			</div>
		);
	}
}
