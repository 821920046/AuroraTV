-- 播放结果统计（替代原来写 KV 的失败计数）。
-- KV 免费版每天仅 1000 次写入，逐次播放上报很容易耗尽额度，进而拖垮首页/搜索缓存写入。
CREATE TABLE IF NOT EXISTS play_stat (
  source_id  TEXT NOT NULL,
  day        TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,
  fail       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, day)
);

CREATE INDEX IF NOT EXISTS idx_play_stat_day ON play_stat(day);

-- 直播频道轮询探活按 updated_at 排序，无索引时全表扫描（频道量可达数万行）。
CREATE INDEX IF NOT EXISTS idx_channel_updated ON channel(updated_at);
CREATE INDEX IF NOT EXISTS idx_channel_active_group ON channel(active, group_title);

-- EPG 按 epg_id + 时间窗查询，补一个联合索引。
CREATE INDEX IF NOT EXISTS idx_epg_lookup ON epg_programme(epg_id, start_ts);
