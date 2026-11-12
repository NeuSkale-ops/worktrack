-- Managed-device control plane for the disclosed Windows monitoring agent.
-- Separate from the per-user 'device' credentials used by the Tauri app: a
-- managed device is a company laptop, mapped to a user by UPN (email) at
-- enrollment, carrying its own bearer token, durable event stream and config.

CREATE TABLE IF NOT EXISTS device_enrollments (
 secret_hash text PRIMARY KEY,
 created_by uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL UNIQUE,
 user_id uuid REFERENCES users(id),
 upn text NOT NULL,
 hostname text NOT NULL DEFAULT '',
 enrolled_at timestamptz NOT NULL DEFAULT now(),
 -- Desired state, applied by the agent on next check-in.
 enabled boolean NOT NULL DEFAULT true,
 paused boolean NOT NULL DEFAULT false,
 uninstall boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(config)='object'),
 config_version integer NOT NULL DEFAULT 1,
 -- Observed state, reported by the agent.
 agent_version text NOT NULL DEFAULT '',
 last_checkin_at timestamptz,
 last_sync_at timestamptz,
 buffer_depth integer NOT NULL DEFAULT 0,
 dropped_events bigint NOT NULL DEFAULT 0,
 acked_seq bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

-- At-least-once send + idempotent ingest = exactly-once delivery. The (device,
-- seq) unique key suppresses duplicates; a reimaged laptop gets a new device id
-- so seq never collides across hardware lifetimes.
CREATE TABLE IF NOT EXISTS device_events (
 device_id uuid NOT NULL REFERENCES devices(id),
 seq bigint NOT NULL,
 event_id uuid NOT NULL,
 kind text NOT NULL,
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 PRIMARY KEY(device_id, seq)
);
CREATE INDEX IF NOT EXISTS device_events_time ON device_events(device_id, occurred_at);

-- Tamper-evident admin audit: each row chains the SHA-256 of the previous row.
CREATE TABLE IF NOT EXISTS admin_audit (
 id bigserial PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES users(id),
 device_id uuid REFERENCES devices(id),
 action text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 at timestamptz NOT NULL DEFAULT now(),
 prev_hash text NOT NULL DEFAULT '',
 hash text NOT NULL
);
