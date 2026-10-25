import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FAV_GROUP,
	FAV_KEY,
	FAV_MAX,
	isFav,
	parseFavs,
	serializeFavs,
	toggleFavId,
} from "./liveFavs.ts";

// ---------------------------------------------------------------- parseFavs

test("parseFavs：正常往返", () => {
	assert.deepEqual(parseFavs('["a","b"]'), ["a", "b"]);
	assert.deepEqual(parseFavs("[]"), []);
});

test("parseFavs：空值与坏 JSON 退回空数组", () => {
	assert.deepEqual(parseFavs(null), []);
	assert.deepEqual(parseFavs(""), []);
	assert.deepEqual(parseFavs("{"), []);
	assert.deepEqual(parseFavs("not json at all"), []);
});

test("parseFavs：非数组形状被拒", () => {
	assert.deepEqual(parseFavs('{"a":1}'), []);
	assert.deepEqual(parseFavs('"a string"'), []);
	assert.deepEqual(parseFavs("42"), []);
	assert.deepEqual(parseFavs("null"), []);
});

test("parseFavs：混合类型只留非空字符串", () => {
	assert.deepEqual(parseFavs('["a",1,null,true,{},"","  ","b"]'), ["a", "  ", "b"]);
});

test("parseFavs：超长被截断到 FAV_MAX", () => {
	const many = Array.from({ length: FAV_MAX + 50 }, (_, i) => "id" + i);
	assert.equal(parseFavs(JSON.stringify(many)).length, FAV_MAX);
});

// ---------------------------------------------------------------- serializeFavs

test("serializeFavs：与 parseFavs 互逆", () => {
	const list = ["x", "y", "z"];
	assert.deepEqual(parseFavs(serializeFavs(list)), list);
});

test("serializeFavs：同样截断到 FAV_MAX，与 parse 的上界一致", () => {
	const many = Array.from({ length: FAV_MAX + 10 }, (_, i) => "id" + i);
	assert.equal(parseFavs(serializeFavs(many)).length, FAV_MAX);
});

test("serializeFavs：过滤脏项，不让它落盘", () => {
	const dirty = ["a", "", "b"] as string[];
	assert.deepEqual(parseFavs(serializeFavs(dirty)), ["a", "b"]);
});

// ---------------------------------------------------------------- toggleFavId

test("toggleFavId：没有则加，有了则删", () => {
	assert.deepEqual(toggleFavId([], "a"), ["a"]);
	assert.deepEqual(toggleFavId(["a"], "a"), []);
	assert.deepEqual(toggleFavId(["a", "b"], "b"), ["a"]);
	assert.deepEqual(toggleFavId(["a"], "b"), ["a", "b"]);
});

test("toggleFavId：不改入参数组", () => {
	const list = ["a"];
	toggleFavId(list, "b");
	toggleFavId(list, "a");
	assert.deepEqual(list, ["a"], "调用方的数组不能被就地修改");
});

test("toggleFavId：空 id 是无效频道，原样返回", () => {
	assert.deepEqual(toggleFavId(["a"], ""), ["a"]);
});

test("toggleFavId：连续切换回原状", () => {
	let list: string[] = [];
	list = toggleFavId(list, "a");
	list = toggleFavId(list, "b");
	list = toggleFavId(list, "a");
	list = toggleFavId(list, "b");
	assert.deepEqual(list, []);
});

// ---------------------------------------------------------------- isFav / 常量

test("isFav：命中与未命中", () => {
	assert.equal(isFav(["a", "b"], "a"), true);
	assert.equal(isFav(["a", "b"], "c"), false);
	assert.equal(isFav([], "a"), false);
});

test("常量：收藏分组哨兵不会与真实分组名碰撞", () => {
	// 真实分组名来自 group-title，可能是「央视」「卫视」甚至空串，
	// 但不会以 __ 开头 —— 这就是选这个前缀的理由
	assert.ok(FAV_GROUP.startsWith("__"), "哨兵值必须带 __ 前缀");
	assert.ok(FAV_KEY.startsWith("aurora:"), "存储键沿用项目前缀");
	assert.ok(FAV_MAX > 0 && FAV_MAX <= 1000, "上限要有个合理量级");
});
