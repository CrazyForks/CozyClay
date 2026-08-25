PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  provider_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_uid)
);
CREATE INDEX identities_account ON identities(account_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled', 'revoked')),
  prompt TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  result_key TEXT,
  error TEXT,
  usage_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX jobs_status_created ON jobs(status, created_at, id);
CREATE INDEX jobs_account_prompt ON jobs(account_id, prompt_hash);
CREATE INDEX jobs_account_created ON jobs(account_id, created_at);
CREATE INDEX jobs_status_lease ON jobs(status, lease_expires_at);
CREATE INDEX jobs_expires ON jobs(expires_at);
CREATE UNIQUE INDEX jobs_one_active_per_account
  ON jobs(account_id) WHERE status IN ('queued', 'running');

CREATE TABLE daily_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  -- Admission 술어 전용 예약 마커; 회계 값이 아니다.
  reserved_job_id TEXT,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE oauth_state (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  next_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE worker_health (
  worker_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  jobs_done_10m INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE worker_nonce (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

CREATE TABLE operational_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  submissions_enabled INTEGER NOT NULL DEFAULT 1 CHECK (submissions_enabled IN (0, 1)),
  updated_at INTEGER,
  updated_by TEXT
);
INSERT INTO operational_state (id, submissions_enabled) VALUES (1, 1);
