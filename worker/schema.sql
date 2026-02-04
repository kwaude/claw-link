CREATE TABLE IF NOT EXISTS agents (
  address TEXT PRIMARY KEY,
  endpoint TEXT,
  encryption_key TEXT,
  registered_at INTEGER,
  message_count INTEGER DEFAULT 0,
  skills TEXT,
  description TEXT,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient, read_at);
CREATE INDEX IF NOT EXISTS idx_agents_skills ON agents(skills);
