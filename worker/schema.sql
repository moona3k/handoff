-- Feedback thread for capsules. Capsule bodies live in KV; their replies live here.
CREATE TABLE IF NOT EXISTS feedback (
  id      TEXT PRIMARY KEY,        -- random short id
  capsule TEXT NOT NULL,           -- capsule slug this reply belongs to
  kind    TEXT NOT NULL,           -- question|correction|approval|concern|idea|impl_note|comment
  body    TEXT NOT NULL,           -- the reply text (plain text, rendered escaped)
  author  TEXT,                    -- optional display name
  contact TEXT,                    -- optional "notify me" handle/email (owner-only visibility)
  created TEXT NOT NULL,           -- ISO-8601
  ip_hash TEXT,                    -- hashed CF-Connecting-IP, for rate-limit + abuse triage
  hidden  INTEGER NOT NULL DEFAULT 0  -- owner moderation
);
CREATE INDEX IF NOT EXISTS idx_feedback_capsule ON feedback(capsule, created);
CREATE INDEX IF NOT EXISTS idx_feedback_ip ON feedback(ip_hash, created);
