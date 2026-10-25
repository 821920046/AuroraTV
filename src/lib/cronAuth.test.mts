import { test } from "node:test";
import assert from "node:assert/strict";
import { isCronAuthorized, type CronRequestLike } from "./cronAuth.ts";

const SECRET = "s3cr3t-cron-value";

/** 按给定输入造一个满足 CronRequestLike 的普通对象 */
function req(opts: { auth?: string | null; secret?: string | null } = {}): CronRequestLike {
	const sp = new Map<string, string>();
	if (opts.secret != null) sp.set("secret", opts.secret);
	const headers = new Map<string, string>();
	if (opts.auth != null) headers.set("authorization", opts.auth);
	return {
		headers: { get: (n) => headers.get(n) ?? null },
		nextUrl: { searchParams: { get: (n) => sp.get(n) ?? null } },
	};
}

test("isCronAuthorized：Bearer 头正确即通过", () => {
	assert.equal(isCronAuthorized(req({ auth: "Bearer " + SECRET }), SECRET), true);
	// scheme 大小写不敏感，前后多余空白容忍
	assert.equal(isCronAuthorized(req({ auth: "bearer " + SECRET }), SECRET), true);
	assert.equal(isCronAuthorized(req({ auth: "BEARER " + SECRET }), SECRET), true);
	assert.equal(isCronAuthorized(req({ auth: "  Bearer   " + SECRET + "  " }), SECRET), true);
});

test("isCronAuthorized：查询串正确即通过（兼容旧部署）", () => {
	assert.equal(isCronAuthorized(req({ secret: SECRET }), SECRET), true);
});

test("isCronAuthorized：错误的 Bearer / 查询串均拒绝", () => {
	assert.equal(isCronAuthorized(req({ auth: "Bearer wrong" }), SECRET), false);
	assert.equal(isCronAuthorized(req({ auth: "Bearer " + SECRET + "x" }), SECRET), false);
	assert.equal(isCronAuthorized(req({ secret: "wrong" }), SECRET), false);
	// 缺 scheme、缺 token、 scheme 错
	assert.equal(isCronAuthorized(req({ auth: SECRET }), SECRET), false);
	assert.equal(isCronAuthorized(req({ auth: "Bearer" }), SECRET), false);
	assert.equal(isCronAuthorized(req({ auth: "Bearer " }), SECRET), false);
	assert.equal(isCronAuthorized(req({ auth: "Basic " + SECRET }), SECRET), false);
});

test("isCronAuthorized：什么都没带时拒绝", () => {
	assert.equal(isCronAuthorized(req(), SECRET), false);
	assert.equal(isCronAuthorized(req({ auth: null, secret: null }), SECRET), false);
});

test("isCronAuthorized：未配置密钥时一律拒绝（空串不能打通）", () => {
	// 关键回归：safeEqual("", "") 为真，没有这道门槛空 ?secret= 就能进
	assert.equal(isCronAuthorized(req({ secret: "" }), undefined), false);
	assert.equal(isCronAuthorized(req({ auth: "Bearer " }), undefined), false);
	assert.equal(isCronAuthorized(req(), ""), false);
	assert.equal(isCronAuthorized(req({ secret: "" }), ""), false);
});

test("isCronAuthorized：Bearer 与查询串可以互为兜底", () => {
	// Bearer 错但查询串对 —— 旧部署的调用方式不该被新逻辑挡掉
	assert.equal(isCronAuthorized(req({ auth: "Bearer nope", secret: SECRET }), SECRET), true);
	// Bearer 对但查询串缺省
	assert.equal(isCronAuthorized(req({ auth: "Bearer " + SECRET, secret: null }), SECRET), true);
});
