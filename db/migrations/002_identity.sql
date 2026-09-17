-- Identity: organisations, users, memberships, refresh tokens (schema `commerce`).
-- StockFlow (Go) had users with a single `role` column and no organisations.

CREATE TABLE organizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  -- `internal` = the supplier running the platform; `buyer` = a customer organisation.
  type         text NOT NULL CHECK (type IN ('buyer', 'internal')),
  tax_code     text,
  is_active    boolean NOT NULL DEFAULT true,
  -- Reserved for credit terms; unused in v1.
  credit_limit numeric(18, 2),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite foreign key on org_members below.
  UNIQUE (id, type)
);

-- Field names follow StockFlow's users table (is_active, full_name).
-- The role moved to org_members; the hash is produced server-side.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A user belongs to one or more organisations with one role in each.
-- org_type is copied from the organisation through a composite foreign key, so the
-- CHECK below can tie roles to the organisation type declaratively: an `ops` role can
-- only exist in an internal organisation and a `buyer` role only in a buyer one.
-- (A CHECK calling a function that reads `organizations` would break dump/restore and
-- would not notice an organisation changing type.)
CREATE TABLE org_members (
  org_id     uuid NOT NULL,
  org_type   text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, org_type) REFERENCES organizations (id, type) ON UPDATE CASCADE,
  CONSTRAINT chk_role_matches_org_type CHECK (
    (org_type = 'internal' AND role IN ('ops', 'ops_admin'))
    OR (org_type = 'buyer' AND role IN ('buyer', 'buyer_admin'))
  )
);
CREATE INDEX idx_org_members_user ON org_members (user_id);

-- Rotating refresh tokens. Only a SHA-256 of the token is stored. Tokens issued from
-- one login share a family; presenting an already-used token revokes the whole family.
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The organisation this login session acts for.
  org_id     uuid NOT NULL REFERENCES organizations (id),
  family_id  uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- Absolute end of the login session. Rotation carries it forward unchanged, so a
  -- session that keeps being refreshed still ends; expires_at never exceeds it.
  session_expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family_id);
