import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mergeByTitle,
	pickSources,
	titleKey,
	type SearchItem,
} from "./aggregator.ts";
import type { VideoSource } from "./sources.ts";
import type { SourceHealth } from "./db.ts";

// ---------------------------------------------------------------- 夹具

/** 造一个搜索条目。默认给全字段，测试里按需覆盖 */
function item(over: Partial<SearchItem> & { source_id: string; vod_id: string }): SearchItem {
	return {
		title: "默认片名",
		...over,
	};
}

function src(id: string, over: Partial<VideoSource> = {}): VideoSource {
	return { id, name: id.toUpperCase() + " 源", api: "https://" + id + ".example/api.php", ...over };
}

function health(id: string, over: Partial<SourceHealth> = {}): SourceHealth {
	return {
		source_id: id,
		success_rate: 1,
		avg_latency_ms: 100,
		score: 0,
		updated_at: 0,
		...over,
	};
}

// ---------------------------------------------------------------- titleKey

test("titleKey：大小写、空白、全角空格都不影响同一性", () => {
	assert.equal(
		titleKey(item({ source_id: "a", vod_id: "1", title: "Spider Man" })),
		titleKey(item({ source_id: "b", vod_id: "2", title: "spider   man" })),
	);
	assert.equal(
		titleKey(item({ source_id: "a", vod_id: "1", title: "蜘蛛侠\u3000英雄归来" })),
		titleKey(item({ source_id: "b", vod_id: "2", title: "蜘蛛侠 英雄归来" })),
	);
});

test("titleKey：括号字符被抹掉，但括号里的内容保留", () => {
	// 括号里往往是片名的一部分（季数、版本号），不能连内容一起丢 ——
	// 否则「庆余年（第二季）」会和「庆余年」合成一部。
	assert.equal(
		titleKey(item({ source_id: "a", vod_id: "1", title: "庆余年（第二季）" })),
		titleKey(item({ source_id: "b", vod_id: "2", title: "庆余年第二季" })),
	);
	// 纯装饰括号（括号里就是片名本身）与裸标题等价
	for (const t of ["【庆余年】", "《庆余年》", "[庆余年]", "(庆余年)", "（庆余年）"]) {
		assert.equal(
			titleKey(item({ source_id: "a", vod_id: "1", title: "庆余年" })),
			titleKey(item({ source_id: "b", vod_id: "2", title: t })),
			t,
		);
	}
	// 括号里带年份的与裸标题不等价：年份是内容不是装饰
	assert.notEqual(
		titleKey(item({ source_id: "a", vod_id: "1", title: "流浪地球（2019）" })),
		titleKey(item({ source_id: "b", vod_id: "2", title: "流浪地球" })),
	);
});

test("titleKey：分隔符被抹掉（两侧内容保留）", () => {
	// 分隔符只是排版，删掉字符即可；两边的文字是内容，必须留下 ——
	// 否则「流浪地球-重制版」会和裸「流浪地球」合成一部。
	const pairs: Array<[string, string]> = [
		["流浪地球: 第二版", "流浪地球第二版"],
		["流浪地球-重制版", "流浪地球重制版"],
		["流浪地球_v2", "流浪地球v2"],
		["流浪地球.重制版", "流浪地球重制版"],
		["流浪地球：重制版", "流浪地球重制版"],
	];
	for (const [decorated, plain] of pairs) {
		assert.equal(
			titleKey(item({ source_id: "a", vod_id: "1", title: decorated })),
			titleKey(item({ source_id: "b", vod_id: "2", title: plain })),
			decorated + " 应等价于 " + plain,
		);
	}
});

test("titleKey：年份是键的一部分，跨年份不合并", () => {
	const a = item({ source_id: "a", vod_id: "1", title: "射雕英雄传", year: 2017 });
	const b = item({ source_id: "b", vod_id: "2", title: "射雕英雄传", year: 2024 });
	assert.notEqual(titleKey(a), titleKey(b));
});

// ---------------------------------------------------------------- mergeByTitle

test("mergeByTitle：同名同年份跨源合并，其余源进 alts", () => {
	const out = mergeByTitle([
		item({ source_id: "a", vod_id: "1", title: "庆余年" }),
		item({ source_id: "b", vod_id: "2", title: "庆余年" }),
		item({ source_id: "c", vod_id: "3", title: "庆余年" }),
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].source_id, "a");
	assert.equal(out[0].alts?.length, 2);
	assert.deepEqual(
		out[0].alts?.map((x) => x.source_id),
		["b", "c"],
	);
	assert.equal(out[0].source_count, 3);
});

test("mergeByTitle：同一源重复出现不占 alts 名额", () => {
	const out = mergeByTitle([
		item({ source_id: "a", vod_id: "1", title: "庆余年" }),
		item({ source_id: "a", vod_id: "9", title: "庆余年" }),
		item({ source_id: "b", vod_id: "2", title: "庆余年" }),
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].vod_id, "1", "主条目保持第一个");
	assert.deepEqual(
		out[0].alts?.map((x) => x.source_id),
		["b"],
	);
	assert.equal(out[0].source_count, 2, "真实源数只数不同 source_id");
});

test("mergeByTitle：不同片不互相合并", () => {
	const out = mergeByTitle([
		item({ source_id: "a", vod_id: "1", title: "庆余年" }),
		item({ source_id: "a", vod_id: "2", title: "雪中悍刀行" }),
		item({ source_id: "a", vod_id: "3", title: "庆余年", year: 2020 }),
	]);
	assert.equal(out.length, 3);
	for (const it of out) assert.equal(it.source_count, 1);
});

test("mergeByTitle：主项缺 poster / remarks 时从副本补齐", () => {
	const out = mergeByTitle([
		item({ source_id: "a", vod_id: "1", title: "庆余年" }),
		item({
			source_id: "b",
			vod_id: "2",
			title: "庆余年",
			poster: "https://pic.example/x.jpg",
			remarks: "全 46 集",
		}),
	]);
	assert.equal(out[0].poster, "https://pic.example/x.jpg");
	assert.equal(out[0].remarks, "全 46 集");
});

test("mergeByTitle：主项已有 poster / remarks 不被副本覆盖", () => {
	const out = mergeByTitle([
		item({ source_id: "a", vod_id: "1", title: "庆余年", poster: "own.jpg", remarks: "HD" }),
		item({ source_id: "b", vod_id: "2", title: "庆余年", poster: "other.jpg", remarks: "4K" }),
	]);
	assert.equal(out[0].poster, "own.jpg");
	assert.equal(out[0].remarks, "HD");
});

test("mergeByTitle：无标题或无 vod_id 的条目被丢弃", () => {
	const out = mergeByTitle([
		item({ source_id: "a", vod_id: "1", title: "" }),
		item({ source_id: "a", vod_id: "", title: "有标题没 ID" }),
		item({ source_id: "a", vod_id: "2", title: "正常" }),
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].title, "正常");
});

test("mergeByTitle：空输入返回空数组", () => {
	assert.deepEqual(mergeByTitle([]), []);
});

test("mergeByTitle：alts 截断在 8 条", () => {
	const items: SearchItem[] = [item({ source_id: "s0", vod_id: "0", title: "热门片" })];
	for (let i = 1; i <= 12; i++) {
		items.push(item({ source_id: "s" + i, vod_id: String(i), title: "热门片" }));
	}
	const out = mergeByTitle(items);
	assert.equal(out[0].alts?.length, 8, "alts 有上限，控制搜索响应体积");
	assert.equal(out[0].source_count, 13, "但真实源数必须照实报");
});

test("mergeByTitle：source_count 不被 alts 截断骗到（角标说谎回归）", () => {
	// 这条锁的是 v0.4.7 修的 bug：UI 角标原先显示 alts.length + 1，
	// 同名片超过 9 个源时开始显示「9 源」而实际有 13 个。
	const items: SearchItem[] = [item({ source_id: "s0", vod_id: "0", title: "泰坦尼克号" })];
	for (let i = 1; i <= 11; i++) {
		items.push(item({ source_id: "s" + i, vod_id: String(i), title: "泰坦尼克号" }));
	}
	const out = mergeByTitle(items);
	assert.equal(out[0].alts?.length, 8);
	assert.equal(out[0].source_count, 12);
	// 角标应该显示 12，而不是 9
	assert.ok((out[0].source_count ?? 0) > (out[0].alts?.length ?? 0) + 1);
});

test("mergeByTitle：单源时 source_count 为 1、alts 为空数组", () => {
	const out = mergeByTitle([item({ source_id: "a", vod_id: "1", title: "冷门片" })]);
	assert.equal(out[0].source_count, 1);
	assert.deepEqual(out[0].alts, []);
});

// ---------------------------------------------------------------- pickSources

test("pickSources：过滤掉禁用的源", () => {
	const list = [
		src("on"),
		src("off", { enabled: false }),
		src("alsoOn"),
		src("off2", { enabled: false }),
	];
	const out = pickSources(list);
	assert.deepEqual(
		out.map((s) => s.id),
		["on", "alsoOn"],
	);
});

test("pickSources：cors=1 优先于更高评分", () => {
	const list = [
		src("highScoreNoCors", { weight: 100 }),
		src("lowScoreCors", { weight: 1 }),
	];
	const h = { highScoreNoCors: health("highScoreNoCors", { cors: 0, score: 999 }), lowScoreCors: health("lowScoreCors", { cors: 1, score: 1 }) };
	const out = pickSources(list, h);
	assert.equal(out[0].id, "lowScoreCors", "能直接网页播放的源排最前");
});

test("pickSources：同 cors 状态下按评分降序", () => {
	const list = [src("mid"), src("best"), src("worst")];
	const h = {
		mid: health("mid", { score: 50, cors: 1 }),
		best: health("best", { score: 90, cors: 1 }),
		worst: health("worst", { score: 10, cors: 1 }),
	};
	assert.deepEqual(
		pickSources(list, h).map((s) => s.id),
		["best", "mid", "worst"],
	);
});

test("pickSources：无健康数据时退回静态 weight", () => {
	const list = [src("light", { weight: 1 }), src("heavy", { weight: 99 })];
	assert.deepEqual(
		pickSources(list).map((s) => s.id),
		["heavy", "light"],
	);
});

test("pickSources：cors 为 null 视为未知，不享受优先", () => {
	const list = [src("unknownCors", { weight: 50 }), src("knownCors", { weight: 10 })];
	const h = {
		unknownCors: health("unknownCors", { cors: null, score: 80 }),
		knownCors: health("knownCors", { cors: 1, score: 20 }),
	};
	assert.equal(pickSources(list, h)[0].id, "knownCors");
});

test("pickSources：limit 生效，默认 8", () => {
	const list = Array.from({ length: 20 }, (_, i) => src("s" + i));
	assert.equal(pickSources(list).length, 8);
	assert.equal(pickSources(list, undefined, 3).length, 3);
});

test("pickSources：不修改调用方传入的数组", () => {
	// 回归保护：若实现改成在入参数组上原地 sort，
	// 调用方（缓存里那份源列表）的顺序会被悄悄改掉
	const list = [src("a", { weight: 1 }), src("b", { weight: 99 })];
	const before = list.map((s) => s.id);
	pickSources(list);
	assert.deepEqual(
		list.map((s) => s.id),
		before,
	);
});

test("pickSources：全部禁用时返回空数组", () => {
	assert.deepEqual(pickSources([src("x", { enabled: false })]), []);
});
