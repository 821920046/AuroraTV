import test from "node:test";
import assert from "node:assert/strict";
import { computeScore, playFactorOf } from "./scoring.ts";

test("playFactorOf：没有样本时中性为 1，评分与旧版完全一致", () => {
	assert.equal(playFactorOf(null), 1);
	assert.equal(playFactorOf(undefined), 1);
	assert.equal(playFactorOf(NaN), 1);
	assert.equal(playFactorOf(Infinity), 1);
});

test("playFactorOf：样本量为 0 时即使 rate 为 0 也保持中性", () => {
	// 防御：调用方可能传了 rate 但漏了 samples，此时不该把源判死
	assert.equal(playFactorOf(0, 0), 1);
	assert.equal(playFactorOf(0.3, 0), 1);
});

test("playFactorOf：成功率 100% 不奖励，只惩罚", () => {
	assert.equal(playFactorOf(1, 10), 1);
	assert.equal(playFactorOf(1, 1000), 1);
});

test("playFactorOf：样本少时向中性收缩，不会因一两次失败就判死", () => {
	// 2 次全败：实测 0，但收缩后仍有 ~0.71
	const few = playFactorOf(0, 2);
	assert.ok(few > 0.7, "2 个样本全败时因子应 > 0.7，实际 " + few);
	// 100 次全败才真正接近 0
	const many = playFactorOf(0, 100);
	assert.ok(many < 0.06, "100 个样本全败时因子应 < 0.06，实际 " + many);
});

test("playFactorOf：样本越多越接近实测值", () => {
	const few = playFactorOf(0.5, 2);
	const mid = playFactorOf(0.5, 10);
	const many = playFactorOf(0.5, 1000);
	assert.ok(few > mid, "样本少时更接近 1");
	assert.ok(mid > many, "样本多时更接近 0.5");
	assert.ok(many > 0.49 && many < 0.52, "大样本应收敛到实测值附近");
});

test("playFactorOf：越界的 rate 会被夹紧", () => {
	assert.equal(playFactorOf(1.5, 100), 1, "大于 1 按 1 算");
	assert.equal(playFactorOf(-3, 100), playFactorOf(0, 100), "负数按 0 算");
});

test("computeScore：没有播放数据时等于旧公式", () => {
	// successRate 1 * speedFactor 0.98 - 0
	assert.equal(computeScore({ successRate: 1, avgLatencyMs: 100, timeouts: 0 }), 0.98);
	assert.equal(
		computeScore({ successRate: 1, avgLatencyMs: 100, timeouts: 0, playRate: null }),
		0.98,
	);
});

test("computeScore：播放一直失败会把接口漂亮的源压下去", () => {
	const good = computeScore({
		successRate: 1,
		avgLatencyMs: 50,
		timeouts: 0,
		playRate: 0.95,
		playSamples: 200,
	});
	const bad = computeScore({
		successRate: 1,
		avgLatencyMs: 50,
		timeouts: 0,
		playRate: 0.1,
		playSamples: 200,
	});
	assert.ok(good > bad, "接口同样快时，播放成功率高的必须分更高");
	assert.ok(bad < good / 2, "播放成功率 10% 的源要显著落后");
});

test("computeScore：接口快但播放全崩的源，不该排在一个接口慢但播放稳的源前面", () => {
	// 这正是用户抱怨的场景：接口 30ms 秒回，但片子根本拉不动
	const fastButBroken = computeScore({
		successRate: 1,
		avgLatencyMs: 30,
		timeouts: 0,
		playRate: 0.05,
		playSamples: 300,
	});
	// 接口 1200ms，但播放成功率 98%
	const slowButWorks = computeScore({
		successRate: 1,
		avgLatencyMs: 1200,
		timeouts: 0,
		playRate: 0.98,
		playSamples: 300,
	});
	assert.ok(
		slowButWorks > fastButBroken,
		"播放能看的源必须胜过接口快但播不动的源（" + slowButWorks + " vs " + fastButBroken + "）",
	);
});

test("computeScore：超时惩罚仍然生效", () => {
	const noTimeout = computeScore({ successRate: 1, avgLatencyMs: 100, timeouts: 0 });
	const withTimeout = computeScore({ successRate: 1, avgLatencyMs: 100, timeouts: 4 });
	assert.ok(withTimeout < noTimeout);
});

test("computeScore：结果保留 4 位小数，避免浮点噪声进数据库", () => {
	const v = computeScore({
		successRate: 0.7777,
		avgLatencyMs: 1234,
		timeouts: 1,
		playRate: 0.6666,
		playSamples: 37,
	});
	assert.equal(v, Number(v.toFixed(4)));
});
