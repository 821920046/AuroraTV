import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// 让 `next dev` 也能访问 Cloudflare 绑定（D1/KV 等）
initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
	// Cloudflare 上不走 Next 默认图片优化
	images: { unoptimized: true },
	reactStrictMode: true,
};

export default nextConfig;
