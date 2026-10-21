PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
  method TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  input_schema TEXT NOT NULL, parameters TEXT NOT NULL, body_property TEXT,
  encrypted_headers TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'rest',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, rate_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, endpoint_id TEXT,
  tool TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL,
  latency REAL NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, key_id TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS request_logs_time ON request_logs(timestamp);
