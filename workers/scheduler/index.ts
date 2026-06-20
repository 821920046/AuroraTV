// 独立的调度 Worker：Cloudflare Cron 触发 scheduled，定时回调主站的
// /api/cron/health 接口。与主站解耦，避免修改 OpenNext 生成的 worker 入口。
export interface Env {
	TARGET_URL: string; // 形如 your-worker.example.workers.dev/api/cron/health
	CRON_SECRET: string;
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const url = "https://" + env.TARGET_URL + "?secret=" + encodeURIComponent(env.CRON_SECRET);
		ctx.waitUntil(fetch(url).then(() => undefined));
	},
};
