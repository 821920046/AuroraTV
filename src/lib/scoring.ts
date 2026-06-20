// 源评分: score = success_rate * speed_factor - timeout_penalty
export function computeScore(opts: {
	successRate: number; // 0..1
	avgLatencyMs: number;
	timeouts: number;
}): number {
	const speedFactor = Math.max(0, 1 - opts.avgLatencyMs / 5000); // 5s 以上趋近 0
	const timeoutPenalty = Math.min(0.5, opts.timeouts * 0.05);
	return Number((opts.successRate * speedFactor - timeoutPenalty).toFixed(4));
}
