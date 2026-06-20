// 影视源注册表。这里只放「元数据/解析」接口，绝不代理视频流。
// 采用常见的苹果CMS (MacCMS) vod JSON API 约定：
//   搜索: {api}?ac=detail&wd=关键词
//   详情: {api}?ac=detail&ids=xxx

export type VideoSource = {
	id: string;
	name: string;
	api: string; // 形如 https://example.com/api.php/provide/vod
	weight?: number; // 静态初始权重（尚无健康评分时使用）
	enabled?: boolean;
};

// TODO: 换成你自己有合法授权的源。这里不预置任何第三方源。
export const SOURCES: VideoSource[] = [
	// { id: "demo", name: "示例源", api: "https://example.com/api.php/provide/vod", weight: 1, enabled: true },
];

export function enabledSources(): VideoSource[] {
	return SOURCES.filter((s) => s.enabled !== false);
}
