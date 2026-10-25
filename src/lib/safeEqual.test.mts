import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEqual } from "./safeEqual.ts";

test("safeEqual：相同字符串为真", () => {
	assert.equal(safeEqual("", ""), true);
	assert.equal(safeEqual("a", "a"), true);
	assert.equal(safeEqual("0123456789abcdef", "0123456789abcdef"), true);
});

test("safeEqual：内容不同为假（含等长）", () => {
	assert.equal(safeEqual("a", "b"), false);
	assert.equal(safeEqual("abcd", "abce"), false);
	// 只有最后一位不同 —— 最容易因提前退出而被测出来
	assert.equal(safeEqual("aaaaaaaaaaaaaaaaaaaaX", "aaaaaaaaaaaaaaaaaaaaY"), false);
});

test("safeEqual：长度不同为假", () => {
	assert.equal(safeEqual("", "a"), false);
	assert.equal(safeEqual("a", ""), false);
	assert.equal(safeEqual("abc", "abcd"), false);
	assert.equal(safeEqual("abcd", "abc"), false);
});

test("safeEqual：高位码位与 NUL 字符", () => {
	assert.equal(safeEqual("\u00e9\u4e2d", "\u00e9\u4e2d"), true);
	assert.equal(safeEqual("\u00e9\u4e2d", "\u00e9\u4e2e"), false);
	// NUL 的码位是 0，不能被 || 0 误判成越界
	assert.equal(safeEqual("a\0b", "a\0b"), true);
	assert.equal(safeEqual("a\0b", "a\0c"), false);
});

test("safeEqual：返回值恒为布尔", () => {
	assert.equal(typeof safeEqual("x", "x"), "boolean");
	assert.equal(typeof safeEqual("x", "y"), "boolean");
	assert.equal(typeof safeEqual("", ""), "boolean");
});
