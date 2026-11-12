-- Enrollment secrets are reusable until they expire or an owner revokes them:
-- Intune passes one install command line to every laptop in an assignment, so a
-- single-use secret enrolled only the first device. used_at now records the
-- most recent use.
ALTER TABLE device_enrollments ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Deduplicate events on the agent-generated event_id instead of seq. A device
-- whose local buffer was recreated restarts seq at 1; keyed on seq, those new
-- events were silently discarded and then acknowledged.
ALTER TABLE device_events DROP CONSTRAINT IF EXISTS device_events_pkey;
ALTER TABLE device_events ADD PRIMARY KEY (device_id, event_id);
CREATE INDEX IF NOT EXISTS device_events_seq ON device_events(device_id, seq);
