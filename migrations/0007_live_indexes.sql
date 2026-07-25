-- 直播模块的补充索引（从 0006 拆出）。
--
-- 为什么这里要先 CREATE TABLE：
-- D1 的 d1_migrations 表只记录「迁移名已执行」，并不校验实际 schema。
-- 如果数据库曾被重建 / 手动 seed 过 d1_migrations / 迁移曾跑在另一个库上，
-- 就会出现「0003 显示已应用，但 channel 表不存在」的错位状态。
-- 因此本迁移自包含：先幂等建表（定义与 0003 完全一致），再建索引。
-- 已正常跑过 0003 的库执行本文件是无副作用的 no-op。

CREATE TABLE IF NOT EXISTS channel (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  group_title  TEXT,
  logo         TEXT,
  stream_url   TEXT NOT NULL,
  epg_id       TEXT,
  country_code TEXT,
  flags        TEXT DEFAULT '{}',
  score        REAL DEFAULT 0,
  active       INTEGER DEFAULT 1,
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_channel_group ON channel(group_title);
CREATE INDEX IF NOT EXISTS idx_channel_active ON channel(active);
CREATE INDEX IF NOT EXISTS idx_channel_score ON channel(score DESC);

CREATE TABLE IF NOT EXISTS live_source (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  enabled    INTEGER DEFAULT 1,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS epg_programme (
  epg_id   TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  stop_ts  INTEGER NOT NULL,
  title    TEXT,
  PRIMARY KEY (epg_id, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_epg_window ON epg_programme(epg_id, start_ts);

-- 以下为本次升级新增的索引：
-- 直播频道轮询探活按 updated_at 排序，无索引时全表扫描（频道量可达数万行）。
CREATE INDEX IF NOT EXISTS idx_channel_updated ON channel(updated_at);
CREATE INDEX IF NOT EXISTS idx_channel_active_group ON channel(active, group_title);
