-- Signing in with Google (spec/sphere-api.md section 3.1): a sign-in waits for Google's callback
-- for 10 minutes, then holds the account and its Workspace until its one-time code is used. Only
-- hashes of the nonce and the code are kept, never the email or the ID token.
CREATE TABLE sign_ins (
  state TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  nonce_sha256 TEXT NOT NULL,
  expires_at_s INTEGER NOT NULL,
  account TEXT,
  workspace TEXT,
  code_sha256 TEXT,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);
CREATE INDEX sign_ins_expiry ON sign_ins (expires_at_s);

-- An open invitation for one Workspace's people (section 4).
ALTER TABLE invitations ADD COLUMN domain TEXT;

-- The account an owner signed in with: one owner per account in a Sphere (section 3.1).
ALTER TABLE owners ADD COLUMN account TEXT;
CREATE UNIQUE INDEX owners_account ON owners (sphere, account) WHERE account IS NOT NULL;
