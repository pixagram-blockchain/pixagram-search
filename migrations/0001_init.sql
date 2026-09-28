-- Pixagram search: D1 schema (SQLite).
-- Metadata only. Image bytes live on chain (and optionally in R2); vectors live in Vectorize.

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  author        TEXT    NOT NULL,
  permlink      TEXT    NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('artwork', 'blog')),
  title         TEXT    NOT NULL DEFAULT '',
  description   TEXT    NOT NULL DEFAULT '',   -- json_metadata.description
  body          TEXT    NOT NULL DEFAULT '',   -- markdown for blog posts; '' for artworks (the data URI stays on chain / R2)
  body_length   INTEGER NOT NULL DEFAULT 0,
  category      TEXT,
  tags_json     TEXT    NOT NULL DEFAULT '[]',
  app           TEXT,
  nsfw          INTEGER NOT NULL DEFAULT 0,    -- author-declared json_metadata.nsfw
  ai_training   INTEGER,                       -- PIXA_LICENSE visitorRights["ai-training"]; NULL = unspecified
  license_json  TEXT,
  royalty_pct   REAL,
  created       INTEGER NOT NULL,              -- unix seconds (chain time is UTC)
  updated       INTEGER NOT NULL,
  block_num     INTEGER,
  deleted       INTEGER NOT NULL DEFAULT 0,    -- Pixagram deletes by editing the body to 'deleted'
  net_votes     INTEGER NOT NULL DEFAULT 0,
  payout        REAL    NOT NULL DEFAULT 0,    -- pending + author + curator payout, PXS
  children      INTEGER NOT NULL DEFAULT 0,
  listed        INTEGER NOT NULL DEFAULT 0,    -- marketplace hook (custom_json), see src/chain/market.ts
  price         REAL,
  price_symbol  TEXT,
  indexed_at    INTEGER NOT NULL,
  UNIQUE (author, permlink)
);
CREATE INDEX IF NOT EXISTS posts_browse  ON posts (deleted, type, created DESC);
CREATE INDEX IF NOT EXISTS posts_author  ON posts (author, created DESC);
CREATE INDEX IF NOT EXISTS posts_votes   ON posts (deleted, net_votes DESC);
CREATE INDEX IF NOT EXISTS posts_payout  ON posts (deleted, payout DESC);
CREATE INDEX IF NOT EXISTS posts_updated ON posts (updated DESC);

CREATE TABLE IF NOT EXISTS artworks (
  post_id           INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  content_hash      TEXT    NOT NULL,          -- sha256 hex of the decoded image bytes
  mime              TEXT    NOT NULL,          -- image/webp | image/png
  bytes             INTEGER NOT NULL,
  lossy             INTEGER NOT NULL DEFAULT 0,-- lossy WebP (VP8) => colour stats are approximate
  width             INTEGER,
  height            INTEGER,
  pixels            INTEGER,
  size_class        TEXT,                      -- icon | tiny | small | medium | large | huge
  color_count       INTEGER,                   -- exact unique opaque colours (native image, before upscaling)
  has_transparency  INTEGER,
  transparent_share REAL,
  primary_color     TEXT,                      -- named bucket, see src/enrich/color.ts
  background_hex    TEXT,
  palette_json      TEXT,                      -- [{hex, share, L, a, b}] top entries by coverage
  buckets_json      TEXT,                      -- [{name, weight}] all buckets with weight
  phash             TEXT,                      -- 64-bit perceptual hash, 16 hex chars
  stats_hash        TEXT,                      -- content_hash the stats were computed for
  embed_hash        TEXT,                      -- content_hash the vector in Vectorize was computed for
  embed_model       TEXT,
  describe_hash     TEXT,                      -- content_hash the AI description was computed for
  vlm_model         TEXT,
  ai_caption        TEXT,
  ai_subjects_json  TEXT,
  ai_tags_json      TEXT,
  ai_style          TEXT,
  ai_mood           TEXT,
  ai_text           TEXT,                      -- text visible in the image
  ai_nsfw           REAL,                      -- model estimate 0..1 (author flag is posts.nsfw)
  r2_orig_key       TEXT,
  r2_up_key         TEXT,
  up_width          INTEGER,
  up_height         INTEGER,
  up_factor         INTEGER,
  updated           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artworks_primary ON artworks (primary_color);
CREATE INDEX IF NOT EXISTS artworks_size    ON artworks (size_class);
CREATE INDEX IF NOT EXISTS artworks_colors  ON artworks (color_count);
CREATE INDEX IF NOT EXISTS artworks_hash    ON artworks (content_hash);

-- One row per (artwork, colour bucket) so "has any of these colours" is an indexed lookup.
CREATE TABLE IF NOT EXISTS artwork_colors (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  bucket  TEXT    NOT NULL,
  weight  REAL    NOT NULL,
  PRIMARY KEY (post_id, bucket)
);
CREATE INDEX IF NOT EXISTS artwork_colors_bucket ON artwork_colors (bucket, weight DESC);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag);

-- pHash split into eight 8-bit chunks: two hashes within Hamming distance 7 share at least one
-- identical chunk (pigeonhole), so near-duplicate lookup is an indexed equality query.
CREATE TABLE IF NOT EXISTS phash_chunks (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  val     INTEGER NOT NULL,
  PRIMARY KEY (post_id, idx)
);
CREATE INDEX IF NOT EXISTS phash_chunks_lookup ON phash_chunks (idx, val);

-- Per-stage job ledger for the enrichment pipeline (idempotency + operator visibility).
CREATE TABLE IF NOT EXISTS jobs (
  post_id  INTEGER NOT NULL,
  stage    TEXT    NOT NULL,                   -- stats | embed | describe
  status   TEXT    NOT NULL,                   -- queued | done | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  error    TEXT,
  updated  INTEGER NOT NULL,
  PRIMARY KEY (post_id, stage)
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, updated);

-- Full-text search. search_docs is the external-content table for posts_fts; the app writes
-- search_docs and the triggers keep the FTS index in sync.
CREATE TABLE IF NOT EXISTS search_docs (
  post_id     INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',        -- blog markdown, truncated
  tags        TEXT NOT NULL DEFAULT '',
  ai_caption  TEXT NOT NULL DEFAULT '',
  ai_tags     TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, description, body, tags, ai_caption, ai_tags, author,
  content='search_docs',
  content_rowid='post_id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO posts_fts(rowid, title, description, body, tags, ai_caption, ai_tags, author)
  VALUES (new.post_id, new.title, new.description, new.body, new.tags, new.ai_caption, new.ai_tags, new.author);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, description, body, tags, ai_caption, ai_tags, author)
  VALUES ('delete', old.post_id, old.title, old.description, old.body, old.tags, old.ai_caption, old.ai_tags, old.author);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, description, body, tags, ai_caption, ai_tags, author)
  VALUES ('delete', old.post_id, old.title, old.description, old.body, old.tags, old.ai_caption, old.ai_tags, old.author);
  INSERT INTO posts_fts(rowid, title, description, body, tags, ai_caption, ai_tags, author)
  VALUES (new.post_id, new.title, new.description, new.body, new.tags, new.ai_caption, new.ai_tags, new.author);
END;

-- Zero-result and slow queries: the cheapest guide to missing synonyms and tags.
CREATE TABLE IF NOT EXISTS query_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  q       TEXT,
  filters TEXT,
  results INTEGER NOT NULL,
  ms      INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS query_log_at ON query_log (at DESC);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
