/**
 * 定长字符串比较，避免时序侧信道。
 *
 * 【为什么单独抽一个模块】
 * 中间件的 Basic Auth、两个 cron 路由的 CRON_SECRET 校验都要比密钥。
 * 在 v0.4.7 之前它们各写各的：中间件有一份私有实现，
 * 而 cron 路由用的是裸 `!==` —— README 里却写着「均使用定长比较」。
 * 文档描述的是设计意图，代码没做到，这种缺口正是该抽公共实现的原因。
 *
 * 【实现要点】
 * 长度不同也**不提前 return**：提前 return 会让「长度猜对没猜对」
 * 本身变成一个时序信号。长度差先并进 diff，循环跑满较长一方的长度，
 * 越界位置按 0 处理（与「短的一方补 \0」等价）。
 */
export function safeEqual(a: string, b: string): boolean {
	let diff = a.length === b.length ? 0 : 1;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		// charCodeAt 越界返回 NaN，|| 0 把它转成 0；正常码位原样通过
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}
