// Ordered schema migrations (spec 6.4). Never edit an applied migration; append a new one.

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  extracted INTEGER NOT NULL DEFAULT 0,
  no_memory INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  emotion TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, id);

CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='trigram');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('profile','preference','fact','episode','schedule')),
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  embedding BLOB,
  due_at TEXT,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','superseded','trashed')),
  superseded_by INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memories_status ON memories(status, kind);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='trigram');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE relationship (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  affinity REAL NOT NULL DEFAULT 0,
  mood REAL NOT NULL DEFAULT 0,
  daily_delta REAL NOT NULL DEFAULT 0,
  delta_date TEXT NOT NULL DEFAULT '',
  first_met_at TEXT NOT NULL
);

CREATE TABLE tool_runs (
  id INTEGER PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  level TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL CHECK (decision IN ('auto','approved','denied','timeout','blocked')),
  undo_json TEXT,
  undone_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE proactive_events (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  reaction TEXT CHECK (reaction IN ('replied','ignored','dismissed'))
);
CREATE INDEX idx_proactive_trigger ON proactive_events(trigger, fired_at);

CREATE TABLE usage_daily (
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model)
);

CREATE TABLE voice_dict (
  id INTEGER PRIMARY KEY,
  surface TEXT NOT NULL,
  pronunciation TEXT NOT NULL,
  accent_type INTEGER NOT NULL,
  word_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  engine_uuid TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE timers (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('timer','reminder')),
  label TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fired_at TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE usage_patterns (
  hour TEXT PRIMARY KEY,        -- local 'YYYY-MM-DDTHH'
  active_minutes INTEGER NOT NULL DEFAULT 0,
  top_app TEXT
);

CREATE TABLE latency (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  speech_end_ms INTEGER,
  transcript_ms INTEGER,
  first_token_ms INTEGER,
  first_sentence_ms INTEGER,
  first_audio_ms INTEGER
);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN extracted_upto INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE usage_daily_v3 (
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model, purpose)
);
INSERT INTO usage_daily_v3 (date, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, usd)
  SELECT date, model, 'other', input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, usd FROM usage_daily;
DROP TABLE usage_daily;
ALTER TABLE usage_daily_v3 RENAME TO usage_daily;
`,
  },
];
