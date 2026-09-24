-- One row per bot folder in the library. Flattened bot.json + inlined markdown.
CREATE TABLE bots (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  category          TEXT NOT NULL,
  about             TEXT NOT NULL,
  features          TEXT NOT NULL,             -- JSON array of 3 strings
  example_prompt    TEXT NOT NULL,
  author_github     TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  author_avatar_url TEXT NOT NULL,             -- derived from author_github
  mascot_body       TEXT NOT NULL,
  mascot_color      TEXT NOT NULL,             -- brand token, e.g. brand-sun
  mascot_activity   TEXT NOT NULL,
  emoji             TEXT NOT NULL,
  agent             TEXT NOT NULL,             -- claude-code | codex | opencode
  permission_mode   TEXT NOT NULL,             -- ask-permissions | auto-approve | plan
  model             TEXT,
  allowed_tools     TEXT,                      -- JSON array or NULL
  disallowed_tools  TEXT,                      -- JSON array or NULL
  instructions      TEXT NOT NULL,             -- instructions.md verbatim
  setup_instructions TEXT,                     -- setup.md verbatim, NULL if absent
  verified_repo     INTEGER NOT NULL DEFAULT 0, -- from verified.json in the library
  verified_override INTEGER,                   -- admin override; NULL = follow verified_repo
  featured_rank     INTEGER,                   -- position in featured.json; NULL = not featured
  content_hash      TEXT NOT NULL,             -- sha256 of the folder's files; drives updated_at
  raw_json          TEXT NOT NULL,             -- bot.json as committed
  install_count     INTEGER NOT NULL DEFAULT 0,
  first_seen_at     TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  removed_at        TEXT                       -- soft delete: set when the folder leaves main
);
CREATE INDEX bots_category_idx ON bots (category);
CREATE INDEX bots_removed_idx  ON bots (removed_at);
CREATE INDEX bots_featured_idx ON bots (featured_rank);

-- One row per POST /admin/reindex.
CREATE TABLE index_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT NOT NULL,                -- running | success | failed
  source         TEXT NOT NULL,                -- github:owner/repo@ref | local:/path
  commit_sha     TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  bots_total     INTEGER,
  bots_added     INTEGER,
  bots_updated   INTEGER,
  bots_unchanged INTEGER,
  bots_removed   INTEGER,
  bots_skipped   INTEGER,
  errors         TEXT NOT NULL DEFAULT '[]',   -- JSON array of { slug, message }
  message        TEXT                          -- failure reason when status = failed
);
CREATE INDEX index_runs_started_idx ON index_runs (started_at);

-- Anonymous install events; bots.install_count is the running total.
CREATE TABLE bot_installs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL REFERENCES bots (slug),
  agent        TEXT,
  installed_at TEXT NOT NULL
);
CREATE INDEX bot_installs_slug_idx ON bot_installs (slug, installed_at);
