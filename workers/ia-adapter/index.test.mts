import { test } from "node:test";
import assert from "node:assert/strict";
import {
	downloadUrl,
	metaToDoc,
	parseCollections,
	pickVideoFile,
	posterUrl,
	resolveCollection,
	sanitizeKeyword,
	searchUrl,
	toDetailRow,
	toRow,
	type Collection,
} from "./index.ts";

// 真实形状来自 Internet Archive metadata（见 UPGRADE.md 的实测记录）
const PHANTOM_FILES = [
	{ name: "Phantom_of_the_Opera.ogv", format: "Ogg Video", size: "441293704", length: "6388.88" },
	{ name: "Phantom_of_the_Opera_512kb.mp4", format: "512Kb MPEG4", size: "463554725", length: "6388.88" },
	{ name: "Phantom_of_the_Opera_256kb.mp4", format: "256Kb MPEG4", size: "200000000", length: "6388.88" },
];

const SILENT: Collection = { type_id: 1, type_name: "经典电影", collection: "silent_films" };

// ---------------------------------------------------------------- parseCollections

test("parseCollections：不填时默认只收 silent_films", () => {
	assert.deepEqual(parseCollections(undefined), [{ type_id: 1, type_name: "经典电影", collection: "silent_films" }]);
	assert.deepEqual(parseCollections(""), parseCollections(undefined));
	assert.deepEqual(parseCollections("   "), parseCollections(undefined));
});

test("parseCollections：自定义合集按顺序编 type_id", () => {
	const got = parseCollections("经典电影:silent_films,恐怖影片:SciFi_Horror");
	assert.deepEqual(got, [
		{ type_id: 1, type_name: "经典电影", collection: "silent_films" },
		{ type_id: 2, type_name: "恐怖影片", collection: "SciFi_Horror" },
	]);
});

test("parseCollections：显示名含冒号时从右侧切", () => {
	// 合集 id 不会含冒号，显示名可能含 —— 从右边切才不会把名字切断
	assert.deepEqual(parseCollections("时间:旅行:silent_films"), [
		{ type_id: 1, type_name: "时间:旅行", collection: "silent_films" },
	]);
});

test("parseCollections：没有冒号时名字与合集同值", () => {
	assert.deepEqual(parseCollections("silent_films"), [
		{ type_id: 1, type_name: "silent_films", collection: "silent_films" },
	]);
});

test("parseCollections：全是空段时退回默认", () => {
	assert.deepEqual(parseCollections(",,, ,"), parseCollections(undefined));
});

test("parseCollections：跳过只有冒号没有合集 id 的段", () => {
	assert.deepEqual(parseCollections("坏段:,好段:silent_films"), [
		{ type_id: 1, type_name: "好段", collection: "silent_films" },
	]);
});

// ---------------------------------------------------------------- pickVideoFile

test("pickVideoFile：偏好 512Kb MPEG4 > 256Kb > 其它可播格式", () => {
	assert.equal(pickVideoFile(PHANTOM_FILES)?.name, "Phantom_of_the_Opera_512kb.mp4");

	const only256 = PHANTOM_FILES.filter((f) => f.format !== "512Kb MPEG4");
	assert.equal(pickVideoFile(only256)?.name, "Phantom_of_the_Opera_256kb.mp4");

	const onlyOther = [
		{ name: "a.mp4", format: "h.264 IA", size: "500000000" },
		{ name: "b.mp4", format: "MPEG4", size: "100" },
	];
	// 同为「其它可播格式」时按体积取最大
	assert.equal(pickVideoFile(onlyOther)?.name, "a.mp4");
});

test("pickVideoFile：认识 h.264 命名（不是所有合集都叫 MPEG4）", () => {
	const files = [
		{ name: "orig.mp4", format: "MPEG4", size: "844000000" },
		{ name: "hd.mp4", format: "h.264 IA", size: "600000000" },
	];
	// h.264 与原片同级，按体积取更大的
	assert.equal(pickVideoFile(files)?.name, "hd.mp4");
});

test("pickVideoFile：只有 h.264 时也能播（不能静默失败）", () => {
	const files = [{ name: "only.mp4", format: "h.264", size: "300000000" }];
	assert.equal(pickVideoFile(files)?.name, "only.mp4");
});

test("pickVideoFile：MPEG2 是上传原片，不能当候选", () => {
	// 实测 house_on_haunted_hill 的原片格式就是 MPEG2，844MB/640x480
	const files = [
		{ name: "orig.mpg", format: "MPEG2", size: "844000000" },
		{ name: "d.mp4", format: "512Kb MPEG4", size: "317000000" },
	];
	assert.equal(pickVideoFile(files)?.name, "d.mp4");

	// 只有 MPEG2 时不该选它 —— 宁可退回 Ogg
	const onlyMpeg2 = [
		{ name: "orig.mpg", format: "MPEG2", size: "844000000" },
		{ name: "d.ogv", format: "Ogg Video", size: "321000000" },
	];
	assert.equal(pickVideoFile(onlyMpeg2)?.name, "d.ogv");
});

test("pickVideoFile：原片与派生档并存时选派生档（省带宽）", () => {
	// 实测：house_on_haunted_hill.mp4 是 MPEG4 原片 844MB/640x480，
	// _512kb.mp4 是派生档 317MB/320x240。免费额度下选派生档。
	const files = [
		{ name: "house_on_haunted_hill.mp4", format: "MPEG4", size: "844000000", length: "4483.21" },
		{ name: "house_on_haunted_hill.ogv", format: "Ogg Video", size: "321000000", length: "4483.12" },
		{ name: "house_on_haunted_hill_512kb.mp4", format: "512Kb MPEG4", size: "317000000", length: "4483.21" },
	];
	assert.equal(pickVideoFile(files)?.name, "house_on_haunted_hill_512kb.mp4");
});

test("pickVideoFile：超体积上限的文件被跳过", () => {
	const files = [
		{ name: "huge.mp4", format: "512Kb MPEG4", size: String(3 * 1024 * 1024 * 1024) },
		{ name: "ok.mp4", format: "256Kb MPEG4", size: "400000000" },
	];
	assert.equal(pickVideoFile(files)?.name, "ok.mp4");
});

test("pickVideoFile：没有 MPEG4 时退回 Ogg", () => {
	const files = [{ name: "only.ogv", format: "Ogg Video", size: "441293704", length: "6388.88" }];
	assert.equal(pickVideoFile(files)?.name, "only.ogv");
});

test("pickVideoFile：体积为 0 或缺失的 MPEG4 不算候选", () => {
	const files = [
		{ name: "zero.mp4", format: "512Kb MPEG4", size: "0" },
		{ name: "nosize.mp4", format: "256Kb MPEG4" },
	];
	assert.equal(pickVideoFile(files), null);
});

test("pickVideoFile：完全没有可播文件时返回 null", () => {
	assert.equal(pickVideoFile([]), null);
	assert.equal(pickVideoFile(null), null);
	assert.equal(pickVideoFile(undefined), null);
	assert.equal(pickVideoFile("not an array"), null);
});

test("pickVideoFile：容忍 files 里的脏数据", () => {
	const files = [null, 42, "str", {}, { name: "", format: "512Kb MPEG4", size: "1" }, ...PHANTOM_FILES];
	assert.equal(pickVideoFile(files)?.name, "Phantom_of_the_Opera_512kb.mp4");
});

test("pickVideoFile：带上 length 供 remarks 用", () => {
	const got = pickVideoFile(PHANTOM_FILES);
	assert.equal(got?.length, 6388.88);
});

// ---------------------------------------------------------------- URL 构造

test("downloadUrl：id 与文件名分段编码", () => {
	assert.equal(
		downloadUrl("ThePhantomoftheOpera", "Phantom_of_the_Opera_512kb.mp4"),
		"https://archive.org/download/ThePhantomoftheOpera/Phantom_of_the_Opera_512kb.mp4",
	);
	// 文件名里的空格与斜杠都要处理：斜杠是路径分隔，必须逐段编码
	assert.equal(
		downloadUrl("my film", "dir name/my file.mp4"),
		"https://archive.org/download/my%20film/dir%20name/my%20file.mp4",
	);
});

test("posterUrl：id 被编码", () => {
	assert.equal(posterUrl("my film"), "https://archive.org/services/img/my%20film");
});

// ---------------------------------------------------------------- searchUrl

test("searchUrl：限定 mediatype 与合集", () => {
	const u = new URL(searchUrl("silent_films", "", 0, 24));
	assert.equal(u.origin + u.pathname, "https://archive.org/advancedsearch.php");
	assert.equal(u.searchParams.get("q"), "mediatype:movies AND collection:silent_films");
	assert.equal(u.searchParams.get("output"), "json");
	assert.equal(u.searchParams.get("rows"), "24");
	assert.equal(u.searchParams.get("start"), "0");
	// 实测通过的 URL 形状：多个 fl[] 参数
	assert.deepEqual(u.searchParams.getAll("fl[]"), ["identifier", "title", "year", "downloads"]);
});

test("searchUrl：关键词包在括号里（多词不会把查询拆散）", () => {
	const u = new URL(searchUrl("silent_films", "phantom opera", 48, 24));
	assert.equal(
		u.searchParams.get("q"),
		"mediatype:movies AND collection:silent_films AND (phantom opera)",
	);
	assert.equal(u.searchParams.get("start"), "48");
});

test("searchUrl：用户词里的特殊字符不会泄漏进查询", () => {
	// 集成级断言：searchUrl 是真实入口，必须自己完成清洗。
	// 查询本身含包裹用的括号，所以只检查 AND 之后那段关键词部分。
	const extract = (q: string) => {
		const m = / AND \((.*)\)$/.exec(q);
		return m ? m[1] : "";
	};
	for (const bad of ["foo)", "title:x", 'a"b', "a&&b", "a[b]", "a~b", "a*b", "a\\b"]) {
		const q = new URL(searchUrl("silent_films", bad, 0, 24)).searchParams.get("q") ?? "";
		const kwPart = extract(q);
		assert.ok(!/[():"&|![\]{}~*?\\]/.test(kwPart), JSON.stringify(bad) + " 泄漏了特殊字符: " + kwPart);
	}
});

test("sanitizeKeyword：查询语法的特殊字符被替换掉（否则整个查询失效）", () => {
	// Internet Archive 的查询语法里这些字符都有特殊含义。
	// AuroraTV 把用户输入原样透传，不清洗会让这个源静默搜不到东西。
	const specials = "():\"+&|![]{}~*?\\";
	for (const ch of specials) {
		const got = sanitizeKeyword("a" + ch + "b");
		assert.ok(!got.includes(ch), "字符 " + JSON.stringify(ch) + " 没被清掉: " + got);
		assert.equal(got, "a b", "应替换成空格: " + got);
	}
});

test("sanitizeKeyword：中文与常规词原样通过", () => {
	assert.equal(sanitizeKeyword("歌剧魅影"), "歌剧魅影");
	assert.equal(sanitizeKeyword("phantom opera"), "phantom opera");
});

test("sanitizeKeyword：只清成标点时退回空串（调用方改为返回热门片）", () => {
	assert.equal(sanitizeKeyword("!!!???"), "");
	assert.equal(sanitizeKeyword("   "), "");
});

test("sanitizeKeyword：压掉连续空格并限长", () => {
	assert.equal(sanitizeKeyword("  a   b  "), "a b");
	assert.equal(sanitizeKeyword("x".repeat(500)).length, 100);
	// 连字符和下划线保留（片名里常见）
	assert.equal(sanitizeKeyword("meta-data_1"), "meta-data_1");
});

// ---------------------------------------------------------------- toRow

test("toRow：字段映射与海报地址", () => {
	const row = toRow(SILENT, {
		identifier: "ThePhantomoftheOpera",
		title: "The Phantom of the Opera",
		year: 1925,
	});
	assert.equal(row.vod_id, "ThePhantomoftheOpera");
	assert.equal(row.vod_name, "The Phantom of the Opera");
	assert.equal(row.vod_pic, "https://archive.org/services/img/ThePhantomoftheOpera");
	assert.equal(row.vod_year, 1925);
	assert.equal(row.type_name, "经典电影");
	assert.equal(row.type_id, 1);
	// 列表行刻意不带 vod_play_url —— 拉它要额外一次 metadata 请求
	assert.equal("vod_play_url" in row, false);
});

test("toRow：缺标题时退回 identifier", () => {
	const row = toRow(SILENT, { identifier: "abc" });
	assert.equal(row.vod_name, "abc");
});

test("toRow：year 非数字时给空串而不是 NaN", () => {
	assert.equal(toRow(SILENT, { identifier: "a", year: "1925" }).vod_year, 1925);
	assert.equal(toRow(SILENT, { identifier: "a", year: "n/a" }).vod_year, "");
	assert.equal(toRow(SILENT, { identifier: "a", year: null }).vod_year, "");
	assert.equal(toRow(SILENT, { identifier: "a" }).vod_year, "");
});

// ---------------------------------------------------------------- toDetailRow

test("toDetailRow：带上播放地址，格式为「正片$URL」", () => {
	const row = toDetailRow(SILENT, { identifier: "ThePhantomoftheOpera", title: "歌剧魅影" }, { files: PHANTOM_FILES });
	assert.equal(row.vod_play_from, "archive.org");
	assert.equal(
		row.vod_play_url,
		"正片$https://archive.org/download/ThePhantomoftheOpera/Phantom_of_the_Opera_512kb.mp4",
	);
});

test("toDetailRow：时长转成分钟角标", () => {
	// 6388.88 秒 ≈ 106 分钟
	assert.equal(toDetailRow(SILENT, { identifier: "x" }, { files: PHANTOM_FILES }).vod_remarks, "106 分钟");
});

test("toDetailRow：时长过短或缺失时不设 remarks", () => {
	const files = [{ name: "a.mp4", format: "512Kb MPEG4", size: "100", length: "30" }];
	assert.equal("vod_remarks" in toDetailRow(SILENT, { identifier: "x" }, { files }), false);

	const noLen = [{ name: "a.mp4", format: "512Kb MPEG4", size: "100" }];
	assert.equal("vod_remarks" in toDetailRow(SILENT, { identifier: "x" }, { files: noLen }), false);
});

test("toDetailRow：没有可播文件时不设播放地址", () => {
	const row = toDetailRow(SILENT, { identifier: "x" }, { files: [] });
	assert.equal("vod_play_url" in row, false);
	// metadata 拉失败时同样优雅降级
	assert.equal("vod_play_url" in toDetailRow(SILENT, { identifier: "x" }, null), false);
});

// ---------------------------------------------------------------- metaToDoc

test("metaToDoc：从 metadata 还原标题与年份", () => {
	const doc = metaToDoc("req-id", {
		metadata: { identifier: "real-id", title: "歌剧魅影", year: 1925 },
	});
	assert.deepEqual(doc, { identifier: "real-id", title: "歌剧魅影", year: 1925 });
});

test("metaToDoc：metadata 不可用时退回请求的 id", () => {
	assert.deepEqual(metaToDoc("req-id", null), { identifier: "req-id" });
	assert.deepEqual(metaToDoc("req-id", {}), { identifier: "req-id" });
	assert.deepEqual(metaToDoc("req-id", { metadata: "not an object" }), { identifier: "req-id" });
	// identifier 为空串时也不能把 vod_id 搞丢；缺 year 时带着 undefined 过去，
	// 消费方 toRow 用 num() 会把它变成 ""，所以行为上等价于没这一项
	assert.deepEqual(metaToDoc("req-id", { metadata: { title: "t" } }), {
		identifier: "req-id",
		title: "t",
		year: undefined,
	});
});

// ---------------------------------------------------------------- resolveCollection

test("resolveCollection：按合集名匹配", () => {
	const cols = parseCollections("经典电影:silent_films,恐怖影片:SciFi_Horror");
	assert.equal(resolveCollection(cols, { metadata: { collection: "SciFi_Horror" } }).type_name, "恐怖影片");
});

test("resolveCollection：collection 可能是数组（一个条目属于多个合集）", () => {
	const cols = parseCollections("经典电影:silent_films,恐怖影片:SciFi_Horror");
	assert.equal(
		resolveCollection(cols, { metadata: { collection: ["library_of_congress", "silent_films"] } }).type_name,
		"经典电影",
	);
});

test("resolveCollection：未知合集退回第一个", () => {
	const cols = parseCollections("经典电影:silent_films,恐怖影片:SciFi_Horror");
	assert.equal(resolveCollection(cols, { metadata: { collection: "something_else" } }).type_name, "经典电影");
	assert.equal(resolveCollection(cols, null).type_name, "经典电影");
	assert.equal(resolveCollection(cols, { metadata: {} }).type_name, "经典电影");
});
