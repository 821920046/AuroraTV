-- AuroraTV 片源表（后台管理 + 订阅导入）
-- 源不再写死在代码里，而是存进 D1，由站长在 /admin 后台增删启停。
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api TEXT NOT NULL,          -- 形如 https://站点/api.php/provide/vod
  detail TEXT,               -- 可选：网页详情根 URL
  weight REAL DEFAULT 1,     -- 静态权重，数字越大优先级越高
  enabled INTEGER DEFAULT 1, -- 1 启用 / 0 停用
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_source_enabled ON source(enabled);
