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
  {
    version: 2,
    name: 'responder: settings, inbox questions, attempts, channel lock',
    sql: `
ALTER TABLE requests ADD COLUMN decision_rumor_json TEXT;
ALTER TABLE requests ADD COLUMN decision_resent_at INTEGER;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE inbox_questions (
  sender_pubkey TEXT NOT NULL CHECK (length(sender_pubkey) = 64),
  question_id TEXT NOT NULL,
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  rumor_created_at INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  text TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatched', 'answered', 'rejected')),
  admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
  receipt_rumor_json TEXT,
  decision TEXT CHECK (decision IN ('answer', 'rejected')),
  reject_reason TEXT CHECK (reject_reason IN ('expired', 'limit', 'unanswered', 'stale_generation')),
  decision_rumor_json TEXT,
  expired_attempts INTEGER NOT NULL DEFAULT 0 CHECK (expired_attempts >= 0),
  received_at INTEGER NOT NULL,
  regenerated_at INTEGER,
  decided_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sender_pubkey, question_id)
);
CREATE INDEX inbox_questions_queue ON inbox_questions (state, received_at);
CREATE INDEX inbox_questions_sender ON inbox_questions (sender_pubkey, received_at);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  sender_pubkey TEXT NOT NULL,
  question_id TEXT NOT NULL,
  code TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'answered', 'expired', 'cancelled')),
  cancel_reason TEXT CHECK (cancel_reason IN ('revoked', 'recovered', 'purged')),
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (sender_pubkey, question_id) REFERENCES inbox_questions (sender_pubkey, question_id) ON DELETE CASCADE
);
CREATE INDEX attempts_state ON attempts (state);
CREATE INDEX attempts_code ON attempts (code);

-- Every code ever handed to Claude. Never purged: a late reply naming an old code must never match a
-- newer question, even after that old question and its attempts were deleted.
CREATE TABLE question_codes (
  code TEXT PRIMARY KEY,
  first_used_at INTEGER NOT NULL
);

CREATE TABLE channel_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  process_start TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  acquired_at INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'questions this person sent',
    sql: `
CREATE TABLE outbox_questions (
  recipient TEXT NOT NULL CHECK (length(recipient) = 64),
  question_id TEXT NOT NULL,
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  text TEXT,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'received', 'answered', 'rejected', 'lost')),
  answer_text TEXT,
  answer_source TEXT,
  answer_confidence TEXT CHECK (answer_confidence IN ('seguro', 'creo', 'no_se')),
  reject_reason TEXT CHECK (reject_reason IN ('expired', 'limit', 'unanswered', 'stale_generation')),
  asked_at INTEGER NOT NULL,
  received_at INTEGER,
  decided_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipient, question_id)
);
-- Open questions are read on every sync (promote to sent, expire to lost), and the list the person
-- sees is ordered by when they asked.
CREATE INDEX outbox_questions_open ON outbox_questions (state, asked_at);
CREATE INDEX outbox_questions_recent ON outbox_questions (asked_at);
CREATE INDEX outbox_questions_rumor ON outbox_questions (rumor_id);
`,
  },
]
