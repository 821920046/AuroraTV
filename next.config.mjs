import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// 让 `next dev` 也能访问 Cloudflare 绑定（D1/KV 等）
initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
	// Cloudflare 上不走 Next 默认图片优化
	images: { unoptimized: true },
	reactStrictMode: true,
	// 这里【故意不再】设置 typescript.ignoreBuildErrors / eslint.ignoreDuringBuilds。
	// 它们曾把构建闸门整个关掉，使类型错误可以静默进生产——正是本次修复的目标之一。
	// 现在类型与 lint 都由 `npm run typecheck` / `npm run lint` 以及 CI 强制把关。
};

export default nextConfig;
