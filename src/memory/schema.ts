export const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS tier1_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo        TEXT    NOT NULL,
    commit_sha  TEXT    NOT NULL,
    event_type  TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_t1_repo_ts ON tier1_events(repo, created_at);
  CREATE INDEX IF NOT EXISTS idx_t1_expires ON tier1_events(expires_at);

  CREATE TABLE IF NOT EXISTS tier2_episodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo         TEXT    NOT NULL,
    date         TEXT    NOT NULL,
    summary      TEXT    NOT NULL,
    raw_event_count INTEGER NOT NULL,
    files_touched TEXT    NOT NULL,
    symbols_touched TEXT NOT NULL,
    decay_score  REAL    DEFAULT 1.0,
    stability    REAL    DEFAULT 7.0,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_t2_repo_date ON tier2_episodes(repo, date);

  CREATE TABLE IF NOT EXISTS tier3_facts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo         TEXT    NOT NULL,
    category     TEXT    NOT NULL,
    subject      TEXT    NOT NULL,
    predicate    TEXT    NOT NULL,
    object       TEXT    NOT NULL,
    confidence   REAL    DEFAULT 1.0,
    source_episode INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_t3_triple ON tier3_facts(repo, subject, predicate);

  CREATE TABLE IF NOT EXISTS tier4_patterns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo          TEXT    NOT NULL,
    pattern_key   TEXT    NOT NULL,
    description   TEXT    NOT NULL,
    example_fqns  TEXT    NOT NULL,
    occurrence_count INTEGER DEFAULT 1,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_t4_key ON tier4_patterns(repo, pattern_key);

  CREATE TABLE IF NOT EXISTS decay_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo          TEXT  NOT NULL,
    run_at        INTEGER NOT NULL,
    nodes_rescored INTEGER DEFAULT 0,
    min_score     REAL,
    max_score     REAL,
    avg_score     REAL
  );

  CREATE TABLE IF NOT EXISTS change_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo        TEXT    NOT NULL,
    symbol_fqn  TEXT    NOT NULL,
    file_path   TEXT    NOT NULL,
    commit_sha  TEXT    NOT NULL,
    author      TEXT    NOT NULL DEFAULT '',
    additions   INTEGER DEFAULT 0,
    deletions   INTEGER DEFAULT 0,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ce_repo_fqn_ts ON change_events(repo, symbol_fqn, ts);
  CREATE INDEX IF NOT EXISTS idx_ce_ts ON change_events(ts);

  CREATE TABLE IF NOT EXISTS hot_zones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo         TEXT    NOT NULL,
    symbol_fqn   TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    velocity     REAL    NOT NULL,
    z_score      REAL    NOT NULL,
    first_flagged INTEGER NOT NULL,
    last_flagged  INTEGER NOT NULL,
    alert_sent    INTEGER DEFAULT 0,
    UNIQUE(repo, symbol_fqn)
  );
`

export function initMemorySchema(db: import('better-sqlite3').Database): void {
  for (const stmt of SQLITE_DDL.split(';').filter(s => s.trim())) {
    db.exec(stmt)
  }
}