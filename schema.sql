CREATE TABLE IF NOT EXISTS links (
  token TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  parts TEXT
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  chat_id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_parts (
  chat_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
