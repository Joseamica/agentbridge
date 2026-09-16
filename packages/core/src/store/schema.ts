export type Migration = { version: number; name: string; sql: string }

// Plans 2 and 3 append their own versions. Never edit a migration once it has shipped.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'contacts, outbox and history cursors',
    sql: `
CREATE TABLE contacts (
  pubkey TEXT NOT NULL CHECK (length(pubkey) = 64),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  state TEXT NOT NULL CHECK (state IN ('requested', 'pending', 'approved', 'rejected', 'revoked')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  max_generation_seen INTEGER NOT NULL DEFAULT 0 CHECK (max_generation_seen >= 0),
  request_id TEXT,
  request_rumor_id TEXT,
  local_name TEXT,
  declared_name TEXT,
  note TEXT,
  relays TEXT NOT NULL DEFAULT '[]',
  requested_at INTEGER,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, direction)
);
CREATE UNIQUE INDEX contacts_local_name ON contacts (direction, local_name) WHERE local_name IS NOT NULL;
CREATE INDEX contacts_requested ON contacts (direction, state, requested_at);

CREATE TABLE requests (
  sender_pubkey TEXT NOT NULL CHECK (length(sender_pubkey) = 64),
  request_id TEXT NOT NULL,
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  decision TEXT CHECK (decision IN ('approved', 'rejected')),
  decision_generation INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (sender_pubkey, request_id)
);

CREATE TABLE outbox (
  recipient TEXT NOT NULL CHECK (length(recipient) = 64),
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  rumor_json TEXT NOT NULL,
  label TEXT NOT NULL,
  pow_bits INTEGER NOT NULL CHECK (pow_bits IN (16, 22)),
  relays TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  policy TEXT NOT NULL CHECK (policy IN ('once', 'retry_until_resolved')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_enqueued_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_generated_at INTEGER NOT NULL,
  last_published_at INTEGER,
  claimed_by TEXT,
  claimed_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipient, rumor_id)
);
CREATE INDEX outbox_due ON outbox (state, next_attempt_at);

CREATE TABLE publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL
);
CREATE INDEX publish_log_at ON publish_log (at);

CREATE TABLE cursors (
  relay TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('asker', 'responder')),
  day_start INTEGER NOT NULL CHECK (day_start % 86400 = 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (relay, role, day_start)
);
`,
  },
]
