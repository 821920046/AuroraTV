// ============================================================================
// 代理签名密钥的解析
// ----------------------------------------------------------------------------
// 【为什么单独一个模块，而不是塞进 proxy.ts】
// proxy.ts 是本项目的安全核心，且必须保持「零 import」才能被 Node 单测直接加载
// （见 src/lib/proxy.test.mts）。而密钥解析要访问 D1 —— 异步、依赖运行时绑定，
// 放进去会直接破坏那个约束。
// 于是按职责切开：纯逻辑（优先级、弱密钥判定）留在 proxy.ts 供单测；
// 需要 IO 的那一层放这里，薄到几乎没有可测的东西。
//
// 这里用「带扩展名的相对路径」而不是 `@/lib/*` 别名：Node 的测试运行器不认 tsconfig
// 的 paths，只有相对路径才能让 secret.test.mts 直接加载本模块。webpack 两种都支持。
// ============================================================================

import { getOrCreatePersistedSecret } from "./db.ts";
import { getExplicitSecret, isProxySecretWeak, pickSecret, type ProxyEnv } from "./proxy.ts";

export type SecretSource = "env" | "d1" | "fallback";

export type ResolvedSecret = {
	secret: string;
	/** env=显式配置；d1=首次访问自动生成并持久化；fallback=公开常量（无防护） */
	source: SecretSource;
};

type SecretEnv = ProxyEnv & { AURORA_DB?: D1Database };

/** 兜底态的缓存时长：D1 可能只是抖动，别让 isolate 一辈子停在无密钥状态。 */
const FALLBACK_TTL_MS = 60_000;

let cached: Promise<ResolvedSecret> | null = null;
/** 0 表示永久有效；非 0 表示在该时刻之后需要重新解析。 */
let cachedUntil = 0;

/**
 * 解析本部署的代理签名密钥。
 *
 * 【为什么要在 isolate 内缓存】
 * /api/stream 每次分片请求、/api/play 每次换集都要用密钥，
 * 不缓存的话每个请求都要读一次 D1 —— 白白吃掉读额度、还多一次往返延迟。
 * 密钥是部署级常量，缓存到 isolate 生命周期结束完全安全。
 */
export function resolveProxySecret(env: SecretEnv): Promise<ResolvedSecret> {
	if (!cached || (cachedUntil !== 0 && Date.now() > cachedUntil)) {
		cachedUntil = 0;
		cached = resolve(env)
			.then((r) => {
				if (r.source === "fallback") cachedUntil = Date.now() + FALLBACK_TTL_MS;
				return r;
			})
			.catch((e) => {
				// resolve() 内部已吞掉所有 IO 异常，这里只防「意料之外」。
				// 关键是必须清掉缓存：否则这个 isolate 会永久卡在一个 rejected Promise 上，
				// 此后每个请求都直接抛，且再也恢复不了。
				console.error("[auroratv] 解析代理签名密钥失败:", e);
				cached = null;
				return { secret: pickSecret(getExplicitSecret(env), null), source: "fallback" as const };
			});
	}
	return cached;
}

async function resolve(env: SecretEnv): Promise<ResolvedSecret> {
	const explicit = getExplicitSecret(env);
	if (explicit) return { secret: explicit, source: "env" };

	const persisted = env.AURORA_DB ? await getOrCreatePersistedSecret(env.AURORA_DB) : null;
	if (persisted) return { secret: persisted, source: "d1" };

	console.error(
		"[auroratv] 代理签名密钥回退到公开常量：/api/stream 与 /api/img 当前处于无鉴权状态。" +
			"请配置 STREAM_SECRET，或确认 D1 绑定 AURORA_DB 可用并已执行 migrations/0008_settings.sql。",
	);
	return { secret: pickSecret(null, null), source: "fallback" };
}

/** 给 /api/health 用：只暴露状态，绝不回显密钥本身。 */
export function describeSecret(r: ResolvedSecret): { source: SecretSource; weak: boolean } {
	return { source: r.source, weak: isProxySecretWeak(r.secret) };
}

/**
 * 仅供单测使用：清空 isolate 内缓存。
 * 生产代码永远不需要调用它 —— 缓存本来就是「跟着 isolate 活一辈子」的语义。
 */
export function __resetSecretCache(): void {
	cached = null;
	cachedUntil = 0;
}
