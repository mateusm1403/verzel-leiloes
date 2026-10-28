CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  public_id VARCHAR(16) NOT NULL UNIQUE,
  display_name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('SELLER', 'BIDDER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lots (
  id UUID PRIMARY KEY,
  seller_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_name VARCHAR(40) NOT NULL,
  source_item_id VARCHAR(80) NOT NULL,
  item_snapshot JSONB NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT NOT NULL,
  starting_cents BIGINT NOT NULL CHECK (starting_cents > 0),
  increment_cents BIGINT NOT NULL CHECK (increment_cents > 0),
  current_bid_cents BIGINT,
  leader_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (current_bid_cents IS NULL OR current_bid_cents >= starting_cents)
);
CREATE INDEX IF NOT EXISTS lots_vitrine_idx ON lots (starts_at, ends_at) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS lots_seller_idx ON lots (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lots_expiry_idx ON lots (ends_at) WHERE settled_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  bidder_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL,
  previous_hash CHAR(64) NOT NULL,
  event_hash CHAR(64) NOT NULL,
  UNIQUE (lot_id, sequence)
);
CREATE INDEX IF NOT EXISTS bids_lot_history_idx ON bids (lot_id, sequence);
CREATE INDEX IF NOT EXISTS bids_bidder_idx ON bids (bidder_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_heads (
  lot_id UUID PRIMARY KEY REFERENCES lots(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  final_hash CHAR(64) NOT NULL,
  signature CHAR(64) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_holds (
  lot_id UUID PRIMARY KEY REFERENCES lots(id) ON DELETE RESTRICT,
  bidder_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_holds_bidder_idx ON wallet_holds (bidder_id);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lot_id UUID REFERENCES lots(id) ON DELETE RESTRICT,
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('DEPOSIT', 'HOLD', 'RELEASE', 'AUCTION_DEBIT', 'SELLER_CREDIT')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_after_cents BIGINT NOT NULL CHECK (balance_after_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx ON wallet_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auction_results (
  lot_id UUID PRIMARY KEY REFERENCES lots(id) ON DELETE RESTRICT,
  receipt_token UUID NOT NULL UNIQUE,
  winner_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  final_cents BIGINT,
  closed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((winner_id IS NULL AND final_cents IS NULL) OR (winner_id IS NOT NULL AND final_cents > 0))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
