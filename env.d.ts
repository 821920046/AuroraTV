// 让 getCloudflareContext().env 拥有类型提示
declare global {
	interface CloudflareEnv {
		AURORA_KV?: KVNamespace;
		AURORA_DB?: D1Database;
		USERNAME?: string;
		PASSWORD?: string;
		CRON_SECRET?: string;
		/** 流代理 HMAC 签名密钥（见 lib/proxy.ts）。未配置时回退到 CRON_SECRET / PASSWORD。 */
		STREAM_SECRET?: string;
		NEXT_PUBLIC_SITE_NAME?: string;
	}
}

export {};
