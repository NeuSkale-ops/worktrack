-- A laptop can be reassigned to another person from the dashboard. Only
-- activity recorded after the assignment is shown under that person, so a
-- laptop's history never moves to its new assignee. NULL keeps the link made
-- at enrollment, which covers the laptop's whole history.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
