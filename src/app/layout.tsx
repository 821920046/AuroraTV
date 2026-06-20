import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "AuroraTV",
	description: "AuroraTV - 影视聚合（基于 MoonTVPlus 魔改）",
	// 默认 noindex：按方案谨慎对待 SEO（避免为版权内容引流）
	robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN">
			<body>{children}</body>
		</html>
	);
}
