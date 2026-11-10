PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  daily_fee_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  replacement_value_cents INTEGER NOT NULL,
  has_samples INTEGER NOT NULL DEFAULT 0,
  tag TEXT
);

CREATE TABLE IF NOT EXISTS accessories (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  list_price_cents INTEGER NOT NULL,
  search_query TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  public_token TEXT UNIQUE NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  fee_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  authorized_cents INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  order_id TEXT,
  authorization_id TEXT,
  capture_id TEXT,
  approve_url TEXT,
  tentative_expires_at TEXT,
  honor_ends_at TEXT,
  hold_expires_at TEXT,
  picked_up_at TEXT,
  returned_at TEXT,
  settled_at TEXT,
  release_ms INTEGER,
  captured_cents INTEGER,
  released_cents INTEGER,
  charges_cents INTEGER,
  excess_cents INTEGER,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_item ON bookings(item_id, start_at);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL,
  paypal_id TEXT,
  status TEXT,
  amount_cents INTEGER,
  request_id TEXT UNIQUE,
  debug_id TEXT,
  raw_json TEXT,
  via TEXT NOT NULL DEFAULT 'rest',
  webhook_confirmed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  phase TEXT NOT NULL,
  angle INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  dhash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  mean_luma REAL NOT NULL,
  exif_taken_at TEXT,
  received_at TEXT NOT NULL,
  sample_set TEXT
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  phase TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  checks_json TEXT,
  result_json TEXT,
  decision TEXT,
  reasons_json TEXT,
  latency_ms INTEGER,
  cached_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER REFERENCES inspections(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  type TEXT NOT NULL,
  part TEXT,
  description TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence REAL,
  photo_index INTEGER,
  pickup_photo_index INTEGER,
  box_json TEXT,
  existing_mark_id TEXT,
  accessory_name TEXT,
  proposed_cents INTEGER NOT NULL DEFAULT 0,
  price_source TEXT,
  decision TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  recommendation_json TEXT,
  refund_cents INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_booking ON events(booking_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  paypal_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  verified INTEGER NOT NULL,
  resource_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS price_quotes (
  query TEXT PRIMARY KEY,
  median_cents INTEGER,
  n_offers INTEGER NOT NULL,
  offers_json TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (day TEXT NOT NULL, ip_hash TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip_hash, kind));
CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, model TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
