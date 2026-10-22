-- Sharing a Mac (spec/protocol.md sections 13 and 14).

-- Each member's latest runner status (sphere-api.md section 6.4): the signed object as it was
-- PUT, and when it expires. Shown only to the owners its `for` names.
CREATE TABLE runner_status (
  sphere TEXT NOT NULL,
  obi TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at_s INTEGER NOT NULL,
  PRIMARY KEY (sphere, obi)
);
