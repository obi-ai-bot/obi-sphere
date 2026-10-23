-- Phone relays (spec/sphere-api.md section 9). A relay belongs to a member's Obi; revoking the
-- member deletes its relays. Only the SHA-256 of each phone's relay token is kept, and nothing of
-- a frame.
CREATE TABLE relays (
  id TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  obi TEXT NOT NULL,
  created_at_s INTEGER NOT NULL
);
CREATE INDEX relays_by_obi ON relays (sphere, obi);

CREATE TABLE relay_devices (
  relay TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  added_at_s INTEGER NOT NULL,
  PRIMARY KEY (relay, token_sha256)
);
