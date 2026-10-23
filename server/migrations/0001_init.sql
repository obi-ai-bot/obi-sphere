-- The Sphere's state (spec/sphere-api.md). Times the API shows are protocol timestamps
-- (`2026-10-14T12:00:00Z`); times only compared are integer seconds since 1970 (`*_s`).

-- One row per Sphere. `rev` grows with every change that a send depends on (the chain, members,
-- keys, policy); writers make their change only if `rev` is still what they read (src/db.ts).
CREATE TABLE spheres (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  admin_owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  policy_rules TEXT NOT NULL,
  policy_updated_at TEXT NOT NULL,
  head_seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  head_recorded_at_s INTEGER,
  rev INTEGER NOT NULL DEFAULT 0,
  writer TEXT
);

-- A row lands here only inside a guarded write, and only when the guard held; the CHECK fails
-- the whole batch otherwise. The same batch deletes it again. The constraint has a name so that
-- a lost turn (`CHECK constraint failed: lost_turn`) is told apart from every other failure.
CREATE TABLE write_guard (
  ok INTEGER NOT NULL CONSTRAINT lost_turn CHECK (ok = 1)
);

-- The owner key bound for each owner (identity.md section 3).
CREATE TABLE owners (
  sphere TEXT NOT NULL,
  owner TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  owner_key_id TEXT NOT NULL,
  PRIMARY KEY (sphere, owner)
);

CREATE TABLE members (
  sphere TEXT NOT NULL,
  obi TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  joined_at TEXT NOT NULL,
  revoked_at TEXT,
  card TEXT NOT NULL,
  card_seq INTEGER NOT NULL,
  PRIMARY KEY (sphere, obi)
);
CREATE INDEX members_by_join ON members (sphere, joined_at, obi);

-- Every key every member ever had; a key id is never used by two members of a Sphere.
CREATE TABLE member_keys (
  sphere TEXT NOT NULL,
  key_id TEXT NOT NULL,
  obi TEXT NOT NULL,
  public_key TEXT NOT NULL,
  valid_from_seq INTEGER NOT NULL,
  valid_until_seq INTEGER,
  PRIMARY KEY (sphere, key_id)
);
CREATE INDEX member_keys_by_obi ON member_keys (sphere, obi, valid_from_seq);

-- Invitations keep only the SHA-256 of their secret.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  owner TEXT NOT NULL,
  obi TEXT NOT NULL,
  secret_sha256 TEXT NOT NULL,
  expires_at_s INTEGER NOT NULL,
  used_at TEXT
);

-- Access tokens: only their SHA-256 is kept.
CREATE TABLE tokens (
  sha256 TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  subject TEXT NOT NULL,
  actor TEXT,
  scope TEXT NOT NULL,
  expires_at_s INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tokens_by_actor ON tokens (sphere, actor);

-- Single-use assertion ids, kept until the assertion expires.
CREATE TABLE used_jtis (
  sphere TEXT NOT NULL,
  iss TEXT NOT NULL,
  jti TEXT NOT NULL,
  exp_s INTEGER NOT NULL,
  PRIMARY KEY (sphere, iss, jti)
);

-- The audit chain. `envelope` is the envelope's canonical JSON, exactly the value its sender
-- signed; the other columns repeat what the exchange rules look at.
CREATE TABLE audit (
  sphere TEXT NOT NULL,
  seq INTEGER NOT NULL,
  prev TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  envelope TEXT NOT NULL,
  hash TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_obi TEXT NOT NULL,
  to_obi TEXT NOT NULL,
  in_reply_to TEXT,
  result_for TEXT,
  PRIMARY KEY (sphere, seq),
  UNIQUE (sphere, msg_id)
);
CREATE INDEX audit_by_reply ON audit (sphere, in_reply_to, seq);

-- The relay queue: one delivery per relayed message, for its `to`.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  sphere TEXT NOT NULL,
  to_obi TEXT NOT NULL,
  seq INTEGER NOT NULL,
  expires_at_s INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'acked', 'dropped'))
);
CREATE INDEX deliveries_queue ON deliveries (sphere, to_obi, state, seq);
