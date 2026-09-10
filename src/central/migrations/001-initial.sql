-- Explicit structure migration. No startup schema repair or data backfill.
CREATE TABLE dataset_metadata (
  id INTEGER PRIMARY KEY, -- Singleton row identity, always 1 by application convention.
  dataset TEXT NOT NULL -- Immutable synthetic/production boundary for this data volume.
);
CREATE TABLE usage_snapshots (
  session_key TEXT PRIMARY KEY, -- member/install/project/anonymous-session composite identity.
  member_id TEXT NOT NULL, -- Reviewed member alias bound to the installation credential.
  installation_id TEXT NOT NULL, -- Reviewed installation alias, never a hostname or path.
  project TEXT NOT NULL, -- Approved project alias, never a repository URL or path.
  session_id TEXT NOT NULL, -- Anonymous UUID allocated by the approved producer.
  first_stop_at TEXT NOT NULL, -- Immutable first measured Stop, UTC; date attribution anchor.
  sequence INTEGER NOT NULL, -- Monotonic producer revision for this logical session.
  observed_at TEXT NOT NULL, -- UTC time when this cumulative snapshot was measured.
  received_at TEXT NOT NULL, -- UTC time when the server accepted the newest revision.
  payload TEXT NOT NULL, -- Validated statistics-only snapshot, including null for unknown counts.
  del_status smallint NOT NULL DEFAULT 0 -- 0 active, 1 soft-deleted; ordinary reads exclude deleted rows.
);
CREATE TABLE receipt_events (
  event_key TEXT PRIMARY KEY, -- Installation plus anonymous event UUID; idempotency identity.
  payload_hash TEXT NOT NULL, -- SHA-256 of the normalized approved snapshot; no credential retained.
  received_at TEXT NOT NULL, -- Server UTC acceptance time for retry acknowledgement.
  del_status smallint NOT NULL DEFAULT 0 -- 0 active, 1 soft-deleted; ordinary reads exclude deleted rows.
);
CREATE INDEX usage_date ON usage_snapshots(first_stop_at);
PRAGMA user_version = 1;
