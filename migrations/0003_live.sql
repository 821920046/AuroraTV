-- AuroraTV 直播模块：频道 / 直播订阅源 / EPG 节目单
-- 接入 Free-TV/IPTV、iptv-org 等 M3U 播放列表。
-- 纪律与点播一致：只存频道元数据与可直连地址，绝不中转视频流。

CREATE TABLE IF NOT EXISTS channel (
  id           TEXT PRIMARY KEY,          -- slug，如 usa_cnn
  name         TEXT NOT NULL,
  group_title  TEXT,                      -- 国家/分类，对应 M3U group-title
  logo         TEXT,
  stream_url   TEXT NOT NULL,
  epg_id       TEXT,                      -- 关联 EPG，如 CNN.us
  country_code TEXT,
  flags        TEXT DEFAULT '{}',         -- JSON: {sd,geoblock,youtube}
  score        REAL DEFAULT 0,            -- 探活评分，复用 scoring 公式
  active       INTEGER DEFAULT 1,         -- 1 有效 / 0 失效但保留（抄 Free-TV [x]）
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_channel_group ON channel(group_title);
CREATE INDEX IF NOT EXISTS idx_channel_active ON channel(active);
CREATE INDEX IF NOT EXISTS idx_channel_score ON channel(score DESC);

-- 直播订阅源（站长在 /admin 管理；为空时回退到代码内置默认源）
CREATE TABLE IF NOT EXISTS live_source (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,               -- M3U 播放列表地址
  enabled    INTEGER DEFAULT 1,
  created_at INTEGER
);

-- EPG 节目单（best-effort，可选）
CREATE TABLE IF NOT EXISTS epg_programme (
  epg_id   TEXT NOT NULL,
  start_ts INTEGER NOT NULL,              -- unix 秒
  stop_ts  INTEGER NOT NULL,
  title    TEXT,
  PRIMARY KEY (epg_id, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_epg_window ON epg_programme(epg_id, start_ts);
