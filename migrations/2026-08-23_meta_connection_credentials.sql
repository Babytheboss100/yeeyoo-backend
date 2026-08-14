-- Server-only encrypted credentials for canonical channel connections.
CREATE TABLE IF NOT EXISTS channel_connection_credentials (
  connection_id TEXT PRIMARY KEY REFERENCES channel_connections(id) ON DELETE CASCADE,
  encrypted_access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
