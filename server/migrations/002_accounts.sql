ALTER TABLE users ADD COLUMN disabled_at timestamptz;
CREATE TABLE password_resets (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets(user_id);
