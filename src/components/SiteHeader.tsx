"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// ============================================================================
// 统一站点头部
// ----------------------------------------------------------------------------
// 【为什么要把头部抽出来】
// 旧版里直播页和管理页各写了一遍一模一样的 header JSX，而首页**完全没有头部**
// —— 后果是首页没有任何入口能进直播页或管理页，只能手敲 URL。
// 三份重复代码还意味着改一次要改三处，且已经出现了不一致（管理页的链接文案
// 是「返回首页」，直播页是「点播 / 管理」）。
//
// 现在统一成一个组件：品牌 + 分段式导航（当前页高亮）+ 移动端自适应。
// ============================================================================

const NAV = [
	{ href: "/", label: "点播" },
	{ href: "/live", label: "直播" },
	{ href: "/admin", label: "管理" },
];

function isActive(pathname: string, href: string): boolean {
	if (href === "/") return pathname === "/";
	return pathname === href || pathname.startsWith(href + "/");
}

export default function SiteHeader() {
	const pathname = usePathname() ?? "/";

	return (
		<header className="site-header">
			<Link className="site-brand" href="/" aria-label="AuroraTV 首页">
				{/* 项目在 Workers 上关闭了 Next 图片优化（images.unoptimized），
				    且这里就是本地静态资源，用原生 <img> 最直接。
				    显式给 width/height：否则图片加载完会引起布局位移（CLS）。 */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img className="logo-badge" src="/logo.png" alt="" width={34} height={34} />
				<span className="wordmark">AuroraTV</span>
			</Link>

			<div className="header-spacer" />

			<nav className="site-nav" aria-label="主导航">
				{NAV.map((n) => {
					const active = isActive(pathname, n.href);
					return (
						<Link
							key={n.href}
							href={n.href}
							className={"site-nav-link" + (active ? " is-active" : "")}
							aria-current={active ? "page" : undefined}
						>
							{n.label}
						</Link>
					);
				})}
			</nav>
		</header>
	);
}
