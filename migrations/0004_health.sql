-- AuroraTV 片源健康：自动停用 / 自动恢复
-- 给 source_health 增加：连续失败计数、自动停用标记、最近一次成功时间。
-- SQLite/D1 支持逐条 ALTER TABLE ADD COLUMN。
ALTER TABLE source_health ADD COLUMN fail_streak INTEGER DEFAULT 0;
ALTER TABLE source_health ADD COLUMN auto_disabled INTEGER DEFAULT 0;
ALTER TABLE source_health ADD COLUMN last_ok_at INTEGER;
