/**
 * 直播频道收藏的纯逻辑。
 *
 * 【为什么单独一个模块】收藏要走 localStorage，而 localStorage 是用户可改的 ——
 * 脏数据不能让页面崩掉（与 Player 的 loadPrefs / loadSkip 同一套逐项校验思路）。
 * 这段校验值得被单测锁住，所以刻意做成「不吃 window、只吃字符串」的纯函数：
 * 页面只负责读写 localStorage，判定全在这里。
 * 与 src/lib/ratelimit.ts 的 readCookie 同一模式。
 */

export const FAV_KEY = "aurora:live:fav:v1";

/**
 * 「收藏」分组的哨兵值。
 * 真实分组名来自 M3U 的 group-title，理论上什么都有，
 * 用 `__` 前缀把碰撞概率压到零（比 FAV_GROUP = "收藏" 安全）。
 */
export const FAV_GROUP = "__fav__";

/** 收藏条数上限：localStorage 通常有 5MB，但没必要让用户存几千个 */
export const FAV_MAX = 200;

/**
 * 解析收藏列表。任何不符合预期的形状都退回空数组，
 * 而不是抛异常或返回一串 undefined 让渲染层炸掉。
 */
export function parseFavs(raw: string | null): string[] {
	if (!raw) return [];
	let p: unknown;
	try {
		p = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(p)) return [];
	// 只保留非空字符串，并截断到上限：防止用户手改出一百万条把内存和渲染拖垮
	return p.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, FAV_MAX);
}

/** 序列化待存盘。超长时截断，与 parseFavs 的上界保持一致。 */
export function serializeFavs(ids: string[]): string {
	return JSON.stringify(ids.filter((x) => typeof x === "string" && x.length > 0).slice(0, FAV_MAX));
}

/** 切换某个频道的收藏状态，返回新列表（不改入参）。 */
export function toggleFavId(list: string[], id: string): string[] {
	if (!id) return list;
	return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * 判断某频道是否已收藏。
 * 抽成函数而不是在渲染处写 `favs.includes(id)`：将来收藏量上来后
 * 可以在这里换 Set 而不动调用点。
 */
export function isFav(list: string[], id: string): boolean {
	return list.includes(id);
}
