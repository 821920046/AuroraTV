// ============================================================================
// 源评分
// ----------------------------------------------------------------------------
// 两个维度，缺一不可：
//   接口层：?ac=list 探活的成功率与延迟 —— 这个源「还在不在、回得快不快」
//   播放层：play_stat 里真实的播放成败 —— 这个源「拉出来的片子能不能看」
//
// 【为什么必须两个都有】
// 只有接口层时，一个源可以接口 50ms 秒回、CORS 正常、评分满分被优先选中，
// 而它的视频文件其实放在一台慢服务器上，十次播放八次卡死。
// 用户感受到的「这个源不专业」，在代码里就是这个缺口 ——
// play_stat 一直在记，却从来没人读。
//
// score = 接口成功率 × 速度因子 × 播放成功率（收缩后） - 超时惩罚
// ============================================================================

/**
 * 播放成功率的「先验样本量」。
 *
 * 【为什么不能直接用 ok/(ok+fail)】
 * 一个源只被播过 2 次、恰好都失败，真实成功率是 0，直接乘进去会让它永远排最后 ——
 * 但它可能只是当时网络抖动，或者那部片本身有问题（不是源的锅）。
 * 用贝叶斯收缩：样本越少，结果越接近中性值 1；样本越多，越接近实测值。
 * 5 个样本之后实测值开始占主导，既不会误杀新源，也不会长期放过烂源。
 */
const PLAY_PRIOR_SAMPLES = 5;

/**
 * 把播放成功率换算成 0..1 的乘数。
 *
 * 没有样本（null / undefined / 非有限数）时返回 1 —— 不奖不罚，
 * 评分退化成改动前的样子。这一点很重要：迁移没跑、或新源还没人播过时，
 * 选源行为必须与旧版完全一致，不能因为缺数据就集体降权。
 */
export function playFactorOf(rate?: number | null, samples = 0): number {
	if (rate === null || rate === undefined || !Number.isFinite(rate)) return 1;
	const n = Number.isFinite(samples) && samples > 0 ? samples : 0;
	const r = Math.min(1, Math.max(0, rate));
	return (r * n + PLAY_PRIOR_SAMPLES) / (n + PLAY_PRIOR_SAMPLES);
}

export type ScoreInput = {
	/** 接口探活成功率 0..1 */
	successRate: number;
	avgLatencyMs: number;
	timeouts: number;
	/** 真实播放成功率 0..1；缺省表示没有样本 */
	playRate?: number | null;
	/** 播放样本量，用于置信度加权 */
	playSamples?: number;
};

export function computeScore(opts: ScoreInput): number {
	const speedFactor = Math.max(0, 1 - opts.avgLatencyMs / 5000); // 5s 以上趋近 0
	const timeoutPenalty = Math.min(0.5, opts.timeouts * 0.05);
	const playFactor = playFactorOf(opts.playRate, opts.playSamples);
	return Number(
		(opts.successRate * speedFactor * playFactor - timeoutPenalty).toFixed(4),
	);
}
