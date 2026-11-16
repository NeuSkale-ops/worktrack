-- Two organisations share one deployment. Each user belongs to at most one.
-- Owners see every org, managers only their own, workers only themselves.
-- Unassigned users (org_id NULL) are visible to owners only until an owner
-- assigns them. Devices, blocks and sessions inherit the org of their user.
CREATE TABLE IF NOT EXISTS orgs (
 id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,40}$'),
 name text NOT NULL
);
INSERT INTO orgs(id,name) VALUES ('neuskale','NeuSkale'),('quantipeak','Quantipeak') ON CONFLICT DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
CREATE INDEX IF NOT EXISTS users_org ON users(org_id);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
