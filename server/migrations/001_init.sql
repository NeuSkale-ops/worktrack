CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
 role text NOT NULL CHECK (role IN ('owner','manager','worker')),
 password_hash text NOT NULL, last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credentials (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('browser','device')), device_name text NOT NULL DEFAULT '',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invites (
 token_hash text PRIMARY KEY, email text NOT NULL, role text NOT NULL CHECK(role IN ('worker','manager')),
 expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE IF NOT EXISTS work_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 started_at timestamptz NOT NULL, stopped_at timestamptz,
 CHECK(stopped_at IS NULL OR stopped_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_session ON work_sessions(user_id) WHERE stopped_at IS NULL;
CREATE TABLE IF NOT EXISTS blocks (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), session_id uuid NOT NULL REFERENCES work_sessions(id),
 start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
 duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 1 AND 600),
 active_seconds integer NOT NULL CHECK(active_seconds >= 0 AND active_seconds <= duration_seconds),
 screenshot_key text NOT NULL DEFAULT '', deleted_at timestamptz,
 CHECK(end_at > start_at AND extract(epoch FROM end_at-start_at)=duration_seconds)
);
CREATE INDEX IF NOT EXISTS blocks_user_time ON blocks(user_id,start_at);
CREATE INDEX IF NOT EXISTS blocks_report_time ON blocks(start_at) WHERE deleted_at IS NULL;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS screenshot_deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS uploads (
 block_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 object_key text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id);
