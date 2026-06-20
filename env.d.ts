// 让 getCloudflareContext().env 拥有类型提示
declare global {
	interface CloudflareEnv {
		AURORA_KV?: KVNamespace;
		AURORA_DB?: D1Database;
		USERNAME?: string;
		PASSWORD?: string;
		CRON_SECRET?: string;
		NEXT_PUBLIC_SITE_NAME?: string;
	}
}

export {};
