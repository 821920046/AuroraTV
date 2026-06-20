-- AuroraTV 初始表结构
CREATE TABLE IF NOT EXISTS movie (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  year INTEGER,
  poster TEXT,
  tags TEXT,            -- JSON 字符串
  rating REAL,
  sources TEXT,         -- JSON: [{source_id, play_url, quality}]
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_movie_year ON movie(year);
CREATE INDEX IF NOT EXISTS idx_movie_rating ON movie(rating);

CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY,
  success_rate REAL,
  avg_latency_ms INTEGER,
  score REAL,
  updated_at INTEGER
);
