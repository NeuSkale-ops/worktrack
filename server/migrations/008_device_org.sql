-- A laptop belongs to an organisation in its own right, set by an owner.
-- Managers see the laptops of their organisation, with or without a person
-- assigned. Until now a laptop borrowed the organisation of its assigned
-- person, so an unassigned laptop belonged to none. Existing laptops keep the
-- organisation of the person they are assigned to.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
CREATE INDEX IF NOT EXISTS devices_org ON devices(org_id);
UPDATE devices d SET org_id=u.org_id FROM users u WHERE u.id=d.user_id AND d.org_id IS NULL;
