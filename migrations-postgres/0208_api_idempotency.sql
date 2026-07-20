-- Strong, tenant-scoped claim/replay store for retryable business POSTs.
-- Workers KV is eventually consistent and cannot atomically claim a key.
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  org_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  response_status INTEGER,
  response_body TEXT,
  response_content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, resource, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_expiry
  ON api_idempotency_keys (expires_at);
