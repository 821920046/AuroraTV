-- 部署级配置表。目前只存一个键：proxy_secret（代理签名密钥）。
--
-- 【为什么需要它 —— 第一性原理】
-- /api/stream 与 /api/img 在 middleware 里被排除在 Basic Auth 之外
-- （hls.js 之外的播放器不会带 Authorization 头），它们唯一的防线是 HMAC 签名。
-- 而签名密钥此前走「STREAM_SECRET → CRON_SECRET → PASSWORD → 硬编码常量」的回退链：
-- 前三个都没配时，密钥就是一个写在源码里、人人可见的常量 ——
-- 任何人据此铸出合法令牌，就能把本站当开放代理用（刷流量、绕地区限制、隐藏真实 IP）。
--
-- 与其逼部署者在「播不了」和「不安全」之间二选一，不如首次访问时生成一个
-- 32 字节（256 bit）随机密钥并持久化到本表：既不需要人工配置任何东西，
-- 也不存在可预测的密钥。STREAM_SECRET 若显式配置，优先级仍高于本表。

CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
