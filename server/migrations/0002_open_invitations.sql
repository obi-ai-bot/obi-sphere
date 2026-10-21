-- Open invitations (spec/sphere-api.md section 4): `owner` and `obi` are null for an open one,
-- which up to `max_uses` Obis redeem; `uses` counts the redeems. SQLite can't drop NOT NULL, so the
-- table is made again; an invitation used before this migration has `uses` 1 of 1.
CREATE TABLE invitations_v2 (
  id TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  owner TEXT,
  obi TEXT,
  secret_sha256 TEXT NOT NULL,
  expires_at_s INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  CHECK ((owner IS NULL) = (obi IS NULL)),
  CHECK (owner IS NULL OR max_uses = 1)
);
INSERT INTO invitations_v2 (id, sphere, owner, obi, secret_sha256, expires_at_s, max_uses, uses)
  SELECT id, sphere, owner, obi, secret_sha256, expires_at_s, 1, CASE WHEN used_at IS NULL THEN 0 ELSE 1 END FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_v2 RENAME TO invitations;
