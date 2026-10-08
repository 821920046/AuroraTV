import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "AuroraTV",
	description: "AuroraTV - 影视聚合（基于 MoonTVPlus 魔改）",
	// 默认 noindex：按方案谨慎对待 SEO（避免为版权内容引流）
	robots: { index: false, follow: false },
	applicationName: "AuroraTV",
	formatDetection: { telephone: false },
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	// 移动端浏览器地址栏与背景同色，视觉上更像原生 App
	themeColor: "#070b14",
	// 允许内容延伸到刘海/圆角区域，配合安全区使用
	viewportFit: "cover",
	// 页面是深色的：告诉浏览器渲染表单控件、滚动条、下拉列表时也用深色配色，
	// 否则 <select> 的弹出列表会是刺眼的白底。
	// 注意必须放在 viewport 而不是 metadata —— Next 15 会对此报「Unsupported metadata」警告。
	colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN">
			<body>{children}</body>
		</html>
	);
}
