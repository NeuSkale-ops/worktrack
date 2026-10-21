-- Agents report records they set aside after a day of permanent server refusal.
ALTER TABLE agent_logs DROP CONSTRAINT IF EXISTS agent_logs_code_check;
ALTER TABLE agent_logs ADD CONSTRAINT agent_logs_code_check CHECK (code IN ('login_failed','sync_failed','capture_failed','activity_failed','queue_failed','heartbeat_failed','update_check_failed','update_install_failed','sync_rejected'));
