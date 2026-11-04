-- Soft revocation of a verified GitHub<->Telegram identity link. History (awards, repositories) keeps
-- its foreign keys; every authorization lookup ignores revoked links. Only the same identity can re-link.
ALTER TABLE github_identity_links ADD COLUMN revoked_at timestamptz;
