-- Phone relays (spec/sphere-api.md section 9). A relay belongs to a member's Obi (`<sphere>/<obi>`)
-- or, on a server whose RELAY_OWNERS is `owner_keys`, to a key (its key id, `ed25519:…`). Only the
-- SHA-256 of each phone's relay token is kept, and nothing of a frame.
CREATE TABLE relays (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at_s INTEGER NOT NULL
);
CREATE INDEX relays_by_owner ON relays (owner);

CREATE TABLE relay_devices (
  relay TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  added_at_s INTEGER NOT NULL,
  PRIMARY KEY (relay, token_sha256)
);
