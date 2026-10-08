// 让 getCloudflareContext().env 拥有类型提示
declare global {
	interface CloudflareEnv {
		AURORA_KV?: KVNamespace;
		AURORA_DB?: D1Database;
		USERNAME?: string;
		PASSWORD?: string;
		CRON_SECRET?: string;
		/**
		 * 流代理 HMAC 签名密钥（见 lib/proxy.ts）。
		 * 未配置时不再回退到 PASSWORD，而是首次访问时生成随机密钥并存入 D1
		 * 的 app_setting 表（见 lib/secret.ts / migrations/0008_settings.sql）。
		 */
		STREAM_SECRET?: string;
		NEXT_PUBLIC_SITE_NAME?: string;
	}
}

export {};
