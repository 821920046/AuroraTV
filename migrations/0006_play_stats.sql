-- 播放结果统计（替代原来写 KV 的失败计数）。
-- KV 免费版每天仅 1000 次写入，逐次播放上报很容易耗尽额度，进而拖垮首页/搜索缓存写入。
--
-- 约束：本文件只能引用它自己创建的对象。
-- （上一版在这里给 channel / epg_programme 建索引，一旦目标库没跑过 0003，
--   整个迁移会因 "no such table: main.channel" 失败，连带 play_stat 也装不上。
--   跨模块的索引已拆到 0007，并在那里先建表再建索引。）

CREATE TABLE IF NOT EXISTS play_stat (
  source_id  TEXT NOT NULL,
  day        TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,
  fail       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, day)
);

CREATE INDEX IF NOT EXISTS idx_play_stat_day ON play_stat(day);
