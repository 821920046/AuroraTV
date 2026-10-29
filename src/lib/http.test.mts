import test from "node:test";
import assert from "node:assert/strict";
import { HEADER_LADDER, ladderWith } from "./http.ts";

test("ladderWith：没有记忆时原样返回默认梯子", () => {
	assert.deepEqual(ladderWith(undefined), HEADER_LADDER);
	// 必须返回同一引用，避免热路径上每次请求都新建数组
	assert.equal(ladderWith(undefined), HEADER_LADDER);
});

test("ladderWith：记住的档位提到最前，其余顺序不变", () => {
	assert.deepEqual(ladderWith("noreferer"), ["noreferer", "browser", "mobile"]);
	assert.deepEqual(ladderWith("mobile"), ["mobile", "browser", "noreferer"]);
});

test("ladderWith：记住的就是第一档时结果与默认一致", () => {
	assert.deepEqual(ladderWith("browser"), HEADER_LADDER);
});

test("ladderWith：不重复、不丢档", () => {
	for (const v of HEADER_LADDER) {
		const out = ladderWith(v);
		assert.equal(out.length, HEADER_LADDER.length, v + " 不能改变梯子长度");
		assert.equal(new Set(out).size, out.length, v + " 不能出现重复档位");
		assert.equal(out[0], v, v + " 必须排在第一位");
	}
});

test("ladderWith：自定义梯子也适用（不假设只有三个档）", () => {
	const custom = ["browser", "mobile"] as const;
	assert.deepEqual(ladderWith("mobile", [...custom]), ["mobile", "browser"]);
});
