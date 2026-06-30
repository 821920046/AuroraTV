// 片源健康探活 + 自动停用 / 自动恢复。
// 由 /api/cron/health（定时）与 /admin「立即体检」共用同一套逻辑。
//
// 设计要点：
//  - 只探活「启用中」的源，外加「被自动停用」的源（用于自动恢复）；手动停用的源不碰。
//  - 连续多轮全部失败才自动停用，单次网络抖动不会误杀。
//  - 一旦探测到恢复，立刻把被自动停用的源重新启用。
//  - 分批探活（最久未检测优先），控制单次请求的子请求数，兼容 Cloudflare 免费版 50 子请求上限。
import { computeScore } from "./scoring";
import { getProbeTargets, upsertSourceHealth, upsertSourceCors } from "./db";
import { setSourceEnabled } from "./sources";
import { pickPlayGroup } from "./aggregator";

export type HealthCheckOptions = {
	limit?: number; // 单次探活的源数量上限（默认 20，最大 40）
	probes?: number; // 每个源探测次数（默认 2，最大 5）
	streak?: number; // 连续失败多少轮后自动停用（默认 3）
	timeoutMs?: number; // 单次探测超时（默认 3000ms）
};

export type HealthCheckResult = {
	checked: number;
	disabled: number;
	recovered: number;
};

export async function runHealthCheck(
	db: D1Database,
	opts: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
	const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 40) : 20;
	const probes = opts.probes && opts.probes > 0 ? Math.min(opts.probes, 5) : 2;
	const streakLimit = opts.streak && opts.streak > 0 ? opts.streak : 3;
	const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 3000;
	const now = Date.now();

	const targets = await getProbeTargets(db, limit);
	let disabled = 0;
	let recovered = 0;

	const results = await Promise.allSettled(
		targets.map(async (s) => {
			let ok = 0;
			let totalMs = 0;
			let timeouts = 0;
			for (let i = 0; i < probes; i++) {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), timeoutMs);
				const start = Date.now();
				try {
					const r = await fetch(`${s.api}?ac=list`, { signal: ctrl.signal });
					if (r.ok) ok++;
					totalMs += Date.now() - start;
				} catch {
					timeouts++;
					totalMs += timeoutMs;
				} finally {
					clearTimeout(t);
				}
			}
			const successRate = ok / probes;
			const avg = Math.round(totalMs / probes);
			const score = computeScore({ successRate, avgLatencyMs: avg, timeouts });

			const failStreak = successRate === 0 ? (s.fail_streak ?? 0) + 1 : 0;
			let autoDisabled = s.auto_disabled ?? 0;

			// 探到成功 -> 恢复被自动停用的源
			if (successRate > 0 && autoDisabled === 1) {
				await setSourceEnabled(db, s.id, true);
				autoDisabled = 0;
				recovered++;
			}
			// 连续失败达到阈值 -> 自动停用（仅针对当前启用的源）
			if (failStreak >= streakLimit && s.enabled && autoDisabled === 0) {
				await setSourceEnabled(db, s.id, false);
				autoDisabled = 1;
				disabled++;
			}

			await upsertSourceHealth(db, {
				source_id: s.id,
				success_rate: successRate,
				avg_latency_ms: avg,
				score,
				updated_at: now,
				fail_streak: failStreak,
				auto_disabled: autoDisabled,
				last_ok_at: successRate > 0 ? now : (s.last_ok_at ?? null),
			});
			return s.id;
		}),
	);

	const checked = results.filter((r) => r.status === "fulfilled").length;
	return { checked, disabled, recovered };
}

// ===== 网页可播性（CORS）探测 =====
// 浏览器播放 HLS 时需跨域拉取 m3u8/ts，片源 CDN 若不返回 Access-Control-Allow-Origin
// 则会被浏览器拦截。服务端 fetch 不受 CORS 限制，可直接读响应头来推断。

const SAMPLE_URL_RE = /^https?:\/\//i;

// 取该源一个样本播放地址（ac=detail 列表中首个可直链播放的地址）。
async function getSamplePlayUrl(api: string, timeoutMs: number): Promise<string> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const r = await fetch(`${api}?ac=detail&pg=1`, { signal: ctrl.signal });
		if (!r.ok) return "";
		const j = (await r.json()) as { list?: Array<Record<string, unknown>> };
		for (const row of j?.list ?? []) {
			const eps = pickPlayGroup(String(row.vod_play_url ?? ""), String(row.vod_play_from ?? ""));
			const first = eps.find((e) => SAMPLE_URL_RE.test(e.url));
			if (first) return first.url;
		}
		return "";
	} catch {
		return "";
	} finally {
		clearTimeout(t);
	}
}

// 返回 1=网页可播（含 ACAO 头），0=会被 CORS 拦截（仅 VLC），null=无法判断（不写库）。
async function probeCors(api: string, timeoutMs: number): Promise<number | null> {
	const sample = await getSamplePlayUrl(api, timeoutMs);
	if (!sample) return null;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const r = await fetch(sample, {
			method: "GET",
			headers: { Range: "bytes=0-0", Origin: "https://aurora.local" },
			signal: ctrl.signal,
		});
		const acao = r.headers.get("access-control-allow-origin");
		return acao && acao.length > 0 ? 1 : 0;
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

export type CorsCheckResult = { checked: number; playable: number; blocked: number };

// 仅做网页可播性探测（每源 2 个子请求），与体检分开调用以兼容免费版 50 子请求上限。
export async function runCorsCheck(
	db: D1Database,
	opts: { limit?: number; timeoutMs?: number } = {},
): Promise<CorsCheckResult> {
	const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 20) : 10;
	const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 6000;
	const now = Date.now();
	const targets = await getProbeTargets(db, limit);
	let checked = 0;
	let playable = 0;
	let blocked = 0;
	await Promise.allSettled(
		targets.map(async (s) => {
			const cors = await probeCors(s.api, timeoutMs);
			if (cors === null) return;
			await upsertSourceCors(db, s.id, cors, now);
			checked++;
			if (cors === 1) playable++;
			else blocked++;
		}),
	);
	return { checked, playable, blocked };
}
